import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { Connection, Keypair } from '@solana/web3.js';
import { Contract, ethers, JsonRpcProvider, WebSocketProvider } from 'ethers';

import evmAbi from '../../ABI/SwarmEventEmitter.json';
import { SwarmEventEmitter as SvmTypes } from '../../IDL/SwarmEventEmitter';
import svmIdl from '../../IDL/SwarmEventEmitter.json';

import { ChainType } from './types';

export class SwarmEventEmitterReader {
  private evm: {
    provider: JsonRpcProvider | WebSocketProvider;
    contract: Contract;
  } | null = null;

  private svm: {
    provider: Connection;
    program: Program<SvmTypes>;
    listenerId?: number;
  } | null = null;

  constructor(
    private chainType: ChainType,
    private rpcUrl: string,
    private contractAddress: string,
    private swarmEmitterAddress: string,
  ) {
    this.init();
  }

  private init() {
    if (this.chainType === 'EVM') {
      this.initEvm();
    } else if (this.chainType === 'SVM') {
      this.initSvm();
    }
  }

  private initEvm() {
    const provider = this.rpcUrl.startsWith('ws')
      ? new ethers.WebSocketProvider(this.rpcUrl)
      : new ethers.JsonRpcProvider(this.rpcUrl);

    const contract = new ethers.Contract(this.contractAddress, evmAbi.abi, provider);
    this.evm = { provider, contract };
  }

  private initSvm() {
    const provider = new Connection(this.rpcUrl, 'confirmed');
    const dummyKeypair = Keypair.generate();
    const wallet = {
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any[]) => txs,
      publicKey: dummyKeypair.publicKey,
    };
    const anchorProvider = new AnchorProvider(provider, wallet, {});
    const program = new Program<SvmTypes>(svmIdl, anchorProvider);

    this.svm = { provider, program };
  }

  public async onMessageFrom(callback: (sender: string, message: string) => void) {
    if (this.chainType === 'EVM') {
      this.listenToEvm(callback);
    } else if (this.chainType === 'SVM') {
      await this.listenToSvm(callback);
    }
  }

  private listenToEvm(callback: (sender: string, message: string) => void) {
    this.evm?.contract.on('MessageLogged', (sender: string, message: string) => {
      if (sender.toLowerCase() === this.swarmEmitterAddress.toLowerCase()) {
        callback(sender, message);
      }
    });
  }

  private async listenToSvm(callback: (sender: string, message: string) => void) {
    const listenerId = this.svm?.program.addEventListener('messageLogged', (event) => {
      const { sender, message } = event;
      if (sender.toBase58() === this.swarmEmitterAddress) {
        callback(sender.toBase58(), message);
      }
    });

    if (this.svm && listenerId !== undefined) {
      this.svm.listenerId = listenerId;
    }
  }

  public async removeAllListeners() {
    if (this.chainType === 'EVM') {
      this.evm?.contract.removeAllListeners('MessageLogged');
    }
    if (this.chainType === 'SVM' && this.svm?.listenerId !== undefined) {
      await this.svm.program.removeEventListener(this.svm.listenerId);
      this.svm.listenerId = undefined;
    }
  }
}
