import { Wallet } from 'ethers';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { privateKey, action } = req.body;
    
    const wallet = new Wallet(privateKey);
    const timestamp = Date.now();
    
    // Hyperliquid 签名格式
    const phantomAgent = {
      source: 'a',
      connectionId: action.hash || wallet.address
    };
    
    const signatureTypes = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' }
      ]
    };
    
    const domain = {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: 421614,
      verifyingContract: '0x0000000000000000000000000000000000000000'
    };
    
    // 签名 Agent
    const agentSignature = await wallet.signTypedData(
      domain,
      signatureTypes,
      phantomAgent
    );
    
    // 签名 Action
    const actionSignature = await wallet.signTypedData(
      domain,
      action.types,
      action.value
    );
    
    return res.status(200).json({
      success: true,
      signature: {
        r: actionSignature.slice(0, 66),
        s: '0x' + actionSignature.slice(66, 130),
        v: parseInt(actionSignature.slice(130, 132), 16)
      },
      nonce: timestamp
    });
    
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
