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
    const { privateKey, market, size, vaultAddress = null } = req.body;
    
    if (!privateKey || !market || !size) {
      throw new Error('Missing required parameters');
    }

    const wallet = new Wallet(privateKey);
    
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

    const timestamp = Date.now();
    const action = {
      type: 'order',
      orders: [{
        a: assetIndex,
        b: false,
        p: '0',
        s: size.toString(),
        r: true,
        t: { limit: { tif: 'Ioc' } }
      }],
      grouping: 'na'
    };

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

    const phantomAgent = {
      source: 'a',
      connectionId: actionHashHex
    };

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
      exit_price: result.response?.data?.statuses?.[0]?.filled?.avgPx || null,
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
