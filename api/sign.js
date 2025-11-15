import { Wallet, keccak256 } from 'ethers';
import { encode } from '@msgpack/msgpack';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { privateKey, market, size, isBuy = true, vaultAddress = null } = req.body;
    
    if (!privateKey || !market || !size) {
      throw new Error('Missing required parameters: privateKey, market, size');
    }

    const wallet = new Wallet(privateKey);
    
    // 步骤 1: 获取资产元数据
    const metaResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'meta' })
    });
    
    const meta = await metaResponse.json();
    let assetIndex = -1;
    let szDecimals = 5; // 默认精度
    
    for (let i = 0; i < meta.universe.length; i++) {
      if (meta.universe[i].name === market) {
        assetIndex = i;
        szDecimals = meta.universe[i].szDecimals || 5;
        break;
      }
    }
    
    if (assetIndex === -1) {
      throw new Error(`Asset ${market} not found`);
    }

    // 步骤 2: 获取当前市场价格
    const midsResponse = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' })
    });
    
    const mids = await midsResponse.json();
    const currentPrice = parseFloat(mids[market]);
    
    if (!currentPrice) {
      throw new Error(`Cannot get current price for ${market}`);
    }
    
    // 计算限价并格式化到正确精度
    const priceMultiplier = isBuy ? 1.05 : 0.95;
    const rawPrice = currentPrice * priceMultiplier;
    
    // 使用 toFixed 并移除尾随零
    const limitPrice = parseFloat(rawPrice.toFixed(szDecimals)).toString();

    // 步骤 3: 构建 action
    const timestamp = Date.now();
    const action = {
      type: 'order',
      orders: [{
        a: assetIndex,
        b: isBuy,
        p: limitPrice,
        s: size.toString(),
        r: false,
        t: { limit: { tif: 'Ioc' } }
      }],
      grouping: 'na'
    };

    // 步骤 4: 计算 action hash
    let data = Buffer.from(encode(action));
    
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64BE(BigInt(timestamp));
    data = Buffer.concat([data, nonceBuffer]);
    
    if (vaultAddress) {
      const vaultAddressBytes = Buffer.from(vaultAddress.slice(2).toLowerCase(), 'hex');
      data = Buffer.concat([data, Buffer.from([0x01]), vaultAddressBytes]);
    } else {
      data = Buffer.concat([data, Buffer.from([0x00])]);
    }
    
    const actionHashHex = keccak256(data);

    // 步骤 5: 构建 Phantom Agent
    const phantomAgent = {
      source: 'a',
      connectionId: actionHashHex
    };

    // 步骤 6: EIP-712 签名
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

    const signature = await wallet.signTypedData(domain, types, phantomAgent);

    // 步骤 7: 发送订单
    const orderRequest = {
      action: action,
      nonce: timestamp,
      signature: {
        r: signature.slice(0, 66),
        s: '0x' + signature.slice(66, 130),
        v: parseInt(signature.slice(130, 132), 16)
      },
      vaultAddress: vaultAddress
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
        asset_index: assetIndex,
        limit_price: limitPrice,
        current_price: currentPrice,
        sz_decimals: szDecimals
      },
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
