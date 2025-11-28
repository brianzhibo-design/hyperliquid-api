import { Wallet, keccak256 } from 'ethers';
import { encode } from '@msgpack/msgpack';

function removeTrailingZeros(numStr) {
  return parseFloat(numStr).toString();
}

// ✅ 根据 tick size 调整价格
function adjustToTickSize(price, tickSize) {
  if (!tickSize || tickSize <= 0) return price;
  return (Math.ceil(price / tickSize) * tickSize).toFixed(8);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: { message: 'Method not allowed. Use POST.' }
    });
  }

  try {
    console.log('=== Request started ===');
    console.log('Body:', JSON.stringify(req.body));
    
    const { market, size, agent_key, tp, sl, timeout } = req.body;
    
    if (!agent_key || !market || !size) {
      return res.status(400).json({
        success: false,
        error: { message: 'Missing required parameters: agent_key, market, size' }
      });
    }

    const wallet = new Wallet(agent_key);
    console.log('Wallet address:', wallet.address);
    
    // 代币名称映射（永续 -> 现货）
    const tokenMap = {
      'ETH': 'UETH',
      'BTC': 'UBTC',
    };
    
    const spotToken = tokenMap[market] || market;
    console.log('Market:', market, '→ Spot token:', spotToken);
    
    // 获取现货元数据
    console.log('=== Fetching SPOT meta ===');
    const metaResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotMeta' })
    });
    
    if (!metaResponse.ok) {
      throw new Error('Failed to fetch spot meta');
    }
    
    const spotMeta = await metaResponse.json();
    console.log('Spot tokens count:', spotMeta.tokens.length);
    console.log('Spot pairs count:', spotMeta.universe.length);
    
    // 找到代币
    let targetToken = null;
    for (const token of spotMeta.tokens) {
      if (token.name === spotToken) {
        targetToken = token;
        break;
      }
    }
    
    if (!targetToken) {
      throw new Error(`Spot token ${spotToken} not found. Available tokens: ${spotMeta.tokens.slice(0, 10).map(t => t.name).join(', ')}...`);
    }
    console.log('Found token:', JSON.stringify(targetToken));
    
    // 找到交易对 (token vs USDC)
    let spotPair = null;
    let spotIndex = -1;
    
    for (const pair of spotMeta.universe) {
      if ((pair.tokens[0] === targetToken.index && pair.tokens[1] === 0) ||
          (pair.tokens[0] === 0 && pair.tokens[1] === targetToken.index)) {
        spotPair = pair;
        spotIndex = pair.index;
        break;
      }
    }
    
    if (!spotPair) {
      throw new Error(`Spot pair ${spotToken}/USDC not found`);
    }
    
    console.log('Found spot pair:', JSON.stringify(spotPair));
    
    // 现货资产索引 = 10000 + universe index
    const assetIndex = 10000 + spotIndex;
    console.log('Asset index for order:', assetIndex);
    
    // 获取价格
    console.log('=== Fetching price ===');
    const midsResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' })
    });
    
    if (!midsResponse.ok) {
      throw new Error('Failed to fetch prices');
    }
    
    const mids = await midsResponse.json();
    console.log('Looking for price with key:', spotPair.name);
    
    let currentPrice = parseFloat(mids[spotPair.name]);
    if (!currentPrice) {
      const altKey = `@${spotIndex}`;
      const altPrice = parseFloat(mids[altKey]);
      if (altPrice) {
        console.log('Price found with alternate key:', altKey);
        currentPrice = altPrice;
      } else {
        throw new Error(`Cannot get price for ${spotPair.name} or ${altKey}. Available keys: ${Object.keys(mids).slice(0, 20).join(', ')}`);
      }
    }
    console.log('Current price:', currentPrice);

    // 构建订单
    console.log('=== Building SPOT order ===');
    const timestamp = Date.now();
    
    const usdAmount = parseFloat(size);
    
    // ✅ 根据 token 精度要求计算 size
    const szDecimals = targetToken.szDecimals || 0;
    const rawSize = usdAmount / currentPrice;
    const szFactor = Math.pow(10, szDecimals);
    const orderSize = (Math.floor(rawSize * szFactor) / szFactor).toString();
    
    // ✅ 根据 tick size 计算价格（加 1% 滑点后对齐）
    // spotMeta.universe[].tickSize 或从 token weiDecimals 推算
    // 通常 tick size 可以从 API 获取，这里用保守方式
    let tickSize = 0.01; // 默认 tick size
    
    // 尝试从 spotPair 获取 tick size（如果有的话）
    if (spotPair.tickSize) {
      tickSize = parseFloat(spotPair.tickSize);
    } else {
      // 根据价格量级推算合理的 tick size
      if (currentPrice > 100) {
        tickSize = 0.1;
      } else if (currentPrice > 10) {
        tickSize = 0.01;
      } else if (currentPrice > 1) {
        tickSize = 0.001;
      } else if (currentPrice > 0.1) {
        tickSize = 0.0001;
      } else {
        tickSize = 0.00001;
      }
    }
    
    const rawSlippagePrice = currentPrice * 1.01;
    const slippagePrice = removeTrailingZeros(adjustToTickSize(rawSlippagePrice, tickSize));
    
    console.log(`Token szDecimals: ${szDecimals}, tickSize: ${tickSize}`);
    console.log(`Order: $${usdAmount} USDC / $${currentPrice} = ${orderSize} ${spotToken} @ $${slippagePrice}`);

    // ✅ 验证 size 不为 0
    if (parseFloat(orderSize) <= 0) {
      throw new Error(`Calculated order size is 0. USD amount: ${usdAmount}, price: ${currentPrice}, szDecimals: ${szDecimals}`);
    }

    const action = {
      type: 'order',
      orders: [{
        a: assetIndex,
        b: true,
        p: slippagePrice,
        s: orderSize,
        r: false,
        t: { limit: { tif: 'Ioc' } }
      }],
      grouping: 'na'
    };
    
    console.log('Action:', JSON.stringify(action));

    // 签名
    console.log('=== Encoding & Signing ===');
    let data = Buffer.from(encode(action));
    console.log('Encoded length:', data.length);
    
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64BE(BigInt(timestamp));
    data = Buffer.concat([data, nonceBuffer, Buffer.from([0x00])]);
    
    const actionHashHex = keccak256(data);
    console.log('Hash:', actionHashHex);
    
    const signature = await wallet.signTypedData(
      {
        name: 'Exchange',
        version: '1',
        chainId: 1337,
        verifyingContract: '0x0000000000000000000000000000000000000000'
      },
      {
        Agent: [
          { name: 'source', type: 'string' },
          { name: 'connectionId', type: 'bytes32' }
        ]
      },
      { source: 'a', connectionId: actionHashHex }
    );
    console.log('Signature:', signature.slice(0, 20) + '...');

    // 发送订单
    console.log('=== Sending SPOT order ===');
    const tradeResponse = await fetch('https://api.hyperliquid.xyz/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: action,
        nonce: timestamp,
        signature: {
          r: signature.slice(0, 66),
          s: '0x' + signature.slice(66, 130),
          v: parseInt(signature.slice(130, 132), 16)
        },
        vaultAddress: null
      })
    });

    const result = await tradeResponse.json();
    console.log('Trade result:', JSON.stringify(result));

    return res.status(200).json({
      success: result.status === 'ok',
      response: result,
      payload: {
        market: market,
        spot_token: spotToken,
        spot_pair: spotPair.name,
        usd_amount: usdAmount,
        size: orderSize,
        price: slippagePrice,
        asset_index: assetIndex,
        sz_decimals: szDecimals,
        tick_size: tickSize
      },
      tp, sl, timeout,
      timestamp
    });

  } catch (error) {
    console.error('=== ERROR ===');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    
    return res.status(500).json({
      success: false,
      error: { 
        message: error.message,
        stack: error.stack
      }
    });
  }
}
