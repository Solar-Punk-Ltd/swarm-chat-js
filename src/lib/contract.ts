import { Contract, ethers, JsonRpcProvider, WebSocketProvider } from 'ethers';

import SwarmEventEmitterMeta from '../../ABI/SwarmEventEmitter.json';

export class SwarmEventEmitterReader {
  private provider: JsonRpcProvider | WebSocketProvider;
  private contract: Contract;
  private swarmEmitterAddress: string;

  constructor(rpcUrl: string, contractAddress: string, swarmEmitterAddress: string) {
    this.provider = this.createProvider(rpcUrl);
    this.contract = new ethers.Contract(contractAddress, SwarmEventEmitterMeta.abi, this.provider);
    this.swarmEmitterAddress = swarmEmitterAddress;
  }

  private createProvider(rpcUrl: string) {
    if (rpcUrl.startsWith('ws')) {
      return new ethers.WebSocketProvider(rpcUrl);
    } else if (rpcUrl.startsWith('http')) {
      return new ethers.JsonRpcProvider(rpcUrl);
    } else {
      throw new Error(`Unsupported RPC URL format: ${rpcUrl}`);
    }
  }

  /**
   * Listen to new MessageLogged events
   */
  public onMessageFrom(callback: (sender: string, message: string) => void) {
    this.contract.on('MessageLogged', (sender: string, message: string) => {
      console.log('DEBUG: new message from', sender, message);
      if (sender.toLowerCase() === this.swarmEmitterAddress.toLowerCase()) {
        callback(sender, message);
      }
    });
  }

  /**
   * Stop all listeners
   */
  public removeAllListeners() {
    this.contract.removeAllListeners('MessageLogged');
  }
}
