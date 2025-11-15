import { Wallet } from 'ethers';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { privateKey, mainWallet, market, size, isBuy = true } = req.body;
    
    if (!privateKey || !mainWallet || !market || !size) {
      throw new Error('Missing required parameters');
    }

    // 使用 Agent Wallet 私钥创建签名者
    const wallet = new Wallet(privateKey);
    
    // 1. 获取资产索引
    const metaResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'meta' })
    });
    
    const meta = await metaResponse.json();
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

    // 2. 构建订单
    const timestamp = Date.now();
    const order = {
      a: assetIndex,
      b: isBuy,
      p: '0',
      s: size.toString(),
      r: false,
      t: { limit: { tif: 'Ioc' } }
    };

    // 3. EIP-712 签名
    const domain = {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000'
    };

    const types = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' }
      ]
    };

    const phantomAgent = {
      source: 'a',
      connectionId: wallet.address
    };

    const signature = await wallet.signTypedData(domain, types, phantomAgent);

    // 4. 发送订单到 Hyperliquid
    const orderRequest = {
      action: {
        type: 'order',
        orders: [order],
        grouping: 'na'
      },
      nonce: timestamp,
      signature: {
        r: signature.slice(0, 66),
        s: '0x' + signature.slice(66, 130),
        v: parseInt(signature.slice(130, 132), 16)
      },
      vaultAddress: mainWallet
    };

    const tradeResponse = await fetch('https://api.hyperliquid.xyz/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderRequest)
    });

    const result = await tradeResponse.json();

    return res.status(200).json({
      success: result.status === 'ok',
      response: result,
      payload: {
        market: market,
        size: parseFloat(size),
        is_buy: isBuy,
        asset_index: assetIndex
      },
      timestamp: timestamp
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: {
        message: error.message,
        type: error.name,
        stack: error.stack
      }
    });
  }
}
