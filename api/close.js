import { Wallet, keccak256 } from 'ethers';
import { encode } from '@msgpack/msgpack';

function removeTrailingZeros(numStr) {
  return parseFloat(numStr).toString();
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
    console.log('=== Close Request Started ===');
    console.log('Body:', JSON.stringify(req.body));
    
    const { market, size, agent_key, main_wallet } = req.body;
    
    if (!agent_key || !market) {
      return res.status(400).json({
        success: false,
        error: { message: 'Missing required parameters: agent_key, market' }
      });
    }

    const wallet = new Wallet(agent_key);
    console.log('API Wallet address:', wallet.address);
    
    // 使用主钱包地址查询余额（如果提供），否则使用 API 钱包地址
    const queryAddress = main_wallet || wallet.address;
    console.log('Query address for balance:', queryAddress);
    
    // 代币名称映射
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
    
    // 找到代币
    let targetToken = null;
    for (const token of spotMeta.tokens) {
      if (token.name === spotToken) {
        targetToken = token;
        break;
      }
    }
    
    if (!targetToken) {
      throw new Error(`Spot token ${spotToken} not found`);
    }
    console.log('Found token:', targetToken.name, 'index:', targetToken.index);
    
    // 找到交易对
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
    
    console.log('Found spot pair:', spotPair.name, 'at index:', spotIndex);
    const assetIndex = 10000 + spotIndex;
    console.log('Asset index:', assetIndex);
    
    // 查询当前持仓（使用主钱包地址或 API 钱包地址）
    console.log('=== Checking current position ===');
    const balanceResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'spotClearinghouseState',
        user: queryAddress
      })
    });
    
    if (!balanceResponse.ok) {
      throw new Error('Failed to fetch balance');
    }
    
    const balanceData = await balanceResponse.json();
    console.log('Balance data:', JSON.stringify(balanceData));
    
    // 找到当前代币余额
    let currentBalance = 0;
    if (balanceData.balances) {
      for (const balance of balanceData.balances) {
        if (balance.token === targetToken.index) {
          currentBalance = parseFloat(balance.total) - parseFloat(balance.hold);
          console.log('Found balance:', {
            coin: balance.coin,
            total: balance.total,
            hold: balance.hold,
            available: currentBalance
          });
          break;
        }
      }
    }
    
    console.log('Current available balance:', currentBalance, spotToken);
    
    if (currentBalance <= 0) {
      return res.status(400).json({
        success: false,
        error: { 
          message: `No ${spotToken} balance to close. Current: ${currentBalance}`,
          details: {
            query_address: queryAddress,
            token: spotToken,
            balance: currentBalance
          }
        }
      });
    }
    
    // 确定要平仓的数量
    let closeSize;
    if (!size || size === 'all') {
      closeSize = currentBalance;
      console.log('Closing entire position:', closeSize);
    } else {
      closeSize = parseFloat(size);
      if (closeSize > currentBalance) {
        closeSize = currentBalance;
        console.log('Requested size exceeds balance, closing max:', closeSize);
      }
    }
    
    // 格式化平仓数量
    const orderSize = removeTrailingZeros(closeSize.toFixed(targetToken.szDecimals || 4));
    
    // 获取当前价格
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
    
    let currentPrice = parseFloat(mids[spotPair.name]);
    if (!currentPrice) {
      const altKey = `@${spotIndex}`;
      currentPrice = parseFloat(mids[altKey]);
      if (!currentPrice) {
        throw new Error(`Cannot get price for ${spotPair.name}`);
      }
    }
    console.log('Current price:', currentPrice);
    
    // 构建平仓订单（市价卖单）
    console.log('=== Building CLOSE order ===');
    const timestamp = Date.now();
    
    // 卖单使用略低于市价的价格
    const slippagePrice = removeTrailingZeros((currentPrice * 0.99).toFixed(1));
    
    console.log(`Close order: ${orderSize} ${spotToken} @ $${slippagePrice} (market sell)`);

    const action = {
      type: 'order',
      orders: [{
        a: assetIndex,
        b: false,        // 卖出
        p: slippagePrice,
        s: orderSize,
        r: true,         // reduce only (只减仓)
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

    // 发送平仓订单
    console.log('=== Sending CLOSE order ===');
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
        closed_size: orderSize,
        price: slippagePrice,
        asset_index: assetIndex,
        query_address: queryAddress
      },
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
