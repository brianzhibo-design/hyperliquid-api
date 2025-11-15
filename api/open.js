import { Wallet, keccak256 } from 'ethers';
import { encode } from '@msgpack/msgpack';

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
    // 添加调试信息
    if (!req.body) {
      return res.status(400).json({
        success: false,
        error: { message: 'Request body is missing' }
      });
    }

    const { market, size, agent_key, tp, sl, timeout } = req.body;
    
    if (!agent_key || !market || !size) {
      return res.status(400).json({
        success: false,
        error: { 
          message: 'Missing required parameters',
          received: { market, size, agent_key: agent_key ? 'present' : 'missing' }
        }
      });
    }

    const wallet = new Wallet(agent_key);
    
    // 1. 获取资产索引和当前价格
    const metaResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'meta' })
    });
    
    if (!metaResponse.ok) {
      throw new Error('Failed to fetch meta data');
    }
    
    const meta = await metaResponse.json();
    
    const midsResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' })
    });
    
    if (!midsResponse.ok) {
      throw new Error('Failed to fetch price data');
    }
    
    const mids = await midsResponse.json();
    
    let assetIndex = -1;
    for (let i = 0; i < meta.universe.length; i++) {
      if (meta.universe[i].name === market) {
        assetIndex = i;
        break;
      }
    }
    
    if (assetIndex === -1) {
      throw new Error(`Asset ${market} not found`);
    }

    const currentPrice = parseFloat(mids[market]);
    if (!currentPrice) {
      throw new Error(`Cannot get price for ${market}`);
    }

    // 2. 构建 Trigger Market 订单
    const timestamp = Date.now();
    const action = {
      type: 'order',
      orders: [{
        a: assetIndex,
        b: true,
        p: "0",
        s: parseFloat(size).toString(),
        r: false,
        t: {
          trigger: {
            isMarket: true,
            triggerPx: currentPrice.toString(),
            tpsl: ""
          }
        }
      }],
      grouping: 'na'
    };

    // 3. 签名
    let data = Buffer.from(encode(action));
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64BE(BigInt(timestamp));
    data = Buffer.concat([data, nonceBuffer, Buffer.from([0x00])]);
    
    const actionHashHex = keccak256(data);
    
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

    // 4. 发送订单
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

    return res.status(200).json({
      success: result.status === 'ok',
      response: result,
      payload: {
        market: market,
        size: parseFloat(size),
        is_buy: true
      },
      tp: tp,
      sl: sl,
      timeout: timeout,
      timestamp: timestamp
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: { 
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      }
    });
  }
}
