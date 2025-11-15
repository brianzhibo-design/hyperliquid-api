import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import { Wallet } from 'ethers';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const config = req.body;
    
    const symbol = config.market || config.symbol;
    const mainWallet = config.main_wallet;
    const privateKey = config.agent_key;
    const size = String(config.size);
    
    if (!symbol || !mainWallet || !privateKey) {
      throw new Error('Missing required parameters');
    }
    
    const wallet = new Wallet(privateKey);
    const transport = new HttpTransport({ 
      url: 'https://api.hyperliquid.xyz'
    });
    
    const client = new ExchangeClient({
      transport,
      wallet,
      walletAddress: mainWallet
    });
    
    const order = {
      coin: symbol,
      is_buy: true,
      sz: size,
      limit_px: '0',
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: false
    };
    
    const result = await client.placeOrder(order);
    
    return res.status(200).json({
      success: true,
      response: result,
      payload: {
        market: symbol,
        size: parseFloat(size),
        is_buy: true
      },
      tp: parseFloat(config.tp),
      sl: parseFloat(config.sl),
      timeout: parseInt(config.timeout),
      timestamp: Date.now()
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
