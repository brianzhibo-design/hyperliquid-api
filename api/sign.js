import { Wallet, keccak256, concat, toUtf8Bytes } from 'ethers';

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
      throw new Error('Missing required parameters: privateKey, mainWallet, market, size');
    }

    const wallet = new Wallet(privateKey);
    
    // 步骤 1: 获取资产索引
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

    // 步骤 2: 构建订单
    const timestamp = Date.now();
    const orderWire = {
      a: assetIndex,
      b: isBuy,
      p: '0',
      s: size.toString(),
      r: false,
      t: { limit: { tif: 'Ioc' } }
    };

    // 步骤 3: 签名
    const connectionId = keccak256(concat([
      toUtf8Bytes('hyperliquid'),
      new Uint8Array([0]),
      new Uint8Array(Buffer.from(wallet.address.slice(2).toLowerCase(), 'hex'))
    ]));

    const phantomDomain = {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: 421614,
      verifyingContract: '0x0000000000000000000000000000000000000000'
    };

    const phantomTypes = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' }
      ]
    };

    const phantomValue = {
      source: 'a',
      connectionId: connectionId
    };

    await wallet.signTypedData(phantomDomain, phantomTypes, phantomValue);

    const actionHash = keccak256(toUtf8Bytes(JSON.stringify(orderWire)));

    const actionTypes = {
      HyperliquidTransaction: [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'action', type: 'bytes32' },
        { name: 'nonce', type: 'uint64' },
        { name: 'vaultAddress', type: 'address' }
      ]
    };

    const actionValue = {
      hyperliquidChain: 'Mainnet',
      action: actionHash,
      nonce: timestamp,
      vaultAddress: mainWallet
    };

    const actionSignature = await wallet.signTypedData(phantomDomain, actionTypes, actionValue);

    // 步骤 4: 发送订单
    const orderRequest = {
      action: {
        type: 'order',
        orders: [orderWire],
        grouping: 'na'
      },
      nonce: timestamp,
      signature: {
        r: actionSignature.slice(0, 66),
        s: '0x' + actionSignature.slice(66, 130),
        v: parseInt(actionSignature.slice(130, 132), 16)
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
      tp: req.body.tp,
      sl: req.body.sl,
      timeout: req.body.timeout,
      timestamp: timestamp
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: {
        message: error.message,
        type: error.name
      }
    });
  }
}
