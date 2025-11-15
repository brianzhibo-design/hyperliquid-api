import { Wallet, keccak256 } from 'ethers';
import { encode } from '@msgpack/msgpack';

// 移除尾随零的函数
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
    console.log('=== Request started ===');
    console.log('Body:', JSON.stringify(req.body));
    
    if (!req.body) {
      return res.status(400).json({
        success: false,
        error: { message: 'Request body is missing' }
      });
    }

    const { market, size, agent_key, tp, sl, timeout } = req.body;
    
    console.log('=== Parsing body ===');
    console.log('Params:', { market, size, has_key: !!agent_key });
    
    if (!agent_key || !market || !size) {
      return res.status(400).json({
        success: false,
        error: { 
          message: 'Missing required parameters',
          received: { market, size, agent_key: agent_key ? 'present' : 'missing' }
        }
      });
    }

    console.log('=== Creating wallet ===');
    const wallet = new Wallet(agent_key);
    console.log('Wallet address:', wallet.address);
    
    console.log('=== Fetching SPOT meta ===');
    const metaResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotMeta' })  // ✅ 现货元数据
    });
    
    if (!metaResponse.ok) {
      throw new Error('Failed to fetch spot meta data');
    }
    
    const spotMeta = await metaResponse.json();
    console.log('Spot meta received, assets count:', spotMeta.universe.length);
    
    console.log('=== Fetching price ===');
    const midsResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' })
    });
    
    if (!midsResponse.ok) {
      throw new Error('Failed to fetch price data');
    }
    
    const mids = await midsResponse.json();
    
    // 现货交易对格式：ETH/USDC
    const spotPair = `${market}/USDC`;
    console.log('Looking for spot pair:', spotPair);
    console.log('Price received for', spotPair, ':', mids[spotPair]);
    
    let spotIndex = -1;
    for (let i = 0; i < spotMeta.universe.length; i++) {
      if (spotMeta.universe[i].name === spotPair) {
        spotIndex = i;
        break;
      }
    }
    
    if (spotIndex === -1) {
      throw new Error(`Spot asset ${spotPair} not found`);
    }
    
    // 现货资产索引 = 10000 + spotMeta 索引
    const assetIndex = 10000 + spotIndex;
    console.log('Spot index:', spotIndex, '→ Asset index:', assetIndex);

    const currentPrice = parseFloat(mids[spotPair]);
    if (!currentPrice) {
      throw new Error(`Cannot get price for ${spotPair}`);
    }

    console.log('=== Building SPOT order ===');
    const timestamp = Date.now();
    
    // 计算订单数量：USD 金额 / 当前价格
    const usdAmount = parseFloat(size);
    const orderSize = removeTrailingZeros((usdAmount / currentPrice).toFixed(4));
    console.log(`Order calculation: $${usdAmount} USDC / $${currentPrice} = ${orderSize} ${market}`);
    
    // 现货市价买单：使用略高于市价的限价 + Ioc
    const slippagePrice = removeTrailingZeros((currentPrice * 1.01).toFixed(1));

    const action = {
      type: 'order',
      orders: [{
        a: assetIndex,  // 10000 + spotIndex
        b: true,
        p: slippagePrice,
        s: orderSize,
        r: false,
        t: { limit: { tif: 'Ioc' } }
      }],
      grouping: 'na'
    };
    
    console.log('Action:', JSON.stringify(action));
    console.log('Order details:', {
      spot_pair: spotPair,
      usd_amount: usdAmount,
      size: orderSize,
      price: slippagePrice,
      current_price: currentPrice,
      asset_index: assetIndex
    });

    console.log('=== Encoding with msgpack ===');
    let data = Buffer.from(encode(action));
    console.log('Encoded length:', data.length);
    
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64BE(BigInt(timestamp));
    data = Buffer.concat([data, nonceBuffer, Buffer.from([0x00])]);
    
    console.log('=== Hashing ===');
    const actionHashHex = keccak256(data);
    console.log('Hash:', actionHashHex);
    
    console.log('=== Signing ===');
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
        market: spotPair,
        usd_amount: usdAmount,
        size: orderSize,
        is_buy: true,
        price: slippagePrice,
        asset_index: assetIndex
      },
      tp: tp,
      sl: sl,
      timeout: timeout,
      timestamp: timestamp
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
