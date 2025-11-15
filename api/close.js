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
    const { privateKey, mainWallet, market, size } = req.body;
    
    if (!privateKey || !mainWallet || !market || !size) {
      throw new Error('Missing required parameters: privateKey, mainWallet, market, size');
    }

    // 使用 Agent Wallet 私钥
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
      throw new Error(`Asset ${market} not found in Hyperliquid universe`);
    }

    // 步骤 2: 构建平仓 action
    const timestamp = Date.now();
    const action = {
      type: 'order',
      orders: [{
        a: assetIndex,
        b: false,  // 卖出
        p: '0',    // 市价单
        s: size.toString(),
        r: true,   // reduce_only = true (只平仓，不开新仓)
        t: { limit: { tif: 'Ioc' } }
      }],
      grouping: 'na'
    };

    // 步骤 3: 计算 action hash
    let data = Buffer.from(encode(action));
    
    // 添加 nonce (8 bytes, big-endian)
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64BE(BigInt(timestamp));
    data = Buffer.concat([data, nonceBuffer]);
    
    // 添加 vault address
    if (mainWallet) {
      const vaultAddressBytes = Buffer.from(mainWallet.slice(2).toLowerCase(), 'hex');
      data = Buffer.concat([data, Buffer.from([0x01]), vaultAddressBytes]);
    } else {
      data = Buffer.concat([data, Buffer.from([0x00])]);
    }
    
    // Keccak256 哈希
    const actionHashHex = keccak256(data);

    // 步骤 4: 构建 Phantom Agent
    const phantomAgent = {
      source: 'a',  // mainnet
      connectionId: actionHashHex
    };

    // 步骤 5: EIP-712 签名
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

    // 步骤 6: 发送平仓订单
    const orderRequest = {
      action: action,
      nonce: timestamp,
      signature: {
        r: signature.slice(0, 66),
        s: '0x' + signature.slice(66, 130),
        v: parseInt(signature.slice(130, 132), 16)
      },
      vaultAddress: null
    };

    const tradeResponse = await fetch('https://api.hyperliquid.xyz/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderRequest)
    });

    const result = await tradeResponse.json();

    // 步骤 7: 返回结果
    return res.status(200)
