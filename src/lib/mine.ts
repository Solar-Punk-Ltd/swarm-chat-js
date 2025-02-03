import { BatchId, Utils } from '@ethersphere/bee-js';
import { InformationSignal } from '@solarpunkltd/gsoc';
import { HexString } from '@solarpunkltd/gsoc/dist/types';

/**
 * Mines the resource ID for the GSOC node. Resource heavy operation.
 * @param url Bee url
 * @param stamp Valid stamp
 * @param overlay Overlay address of the node
 * @param topic Topic for the chat
 */
export function mineResourceId(url: string, stamp: BatchId, overlay: string, topic: string): HexString<number> | null {
  try {
    const informationSignal = new InformationSignal(url, {
      consensus: {
        id: `SwarmDecentralizedChat::${topic}`,
        assertRecord: (_input) => {
          return true;
        },
      },
      postage: stamp,
    });

    const DEPTH = 24;
    const mineResult = informationSignal.mineResourceId(Utils.hexToBytes(overlay), DEPTH);

    return Utils.bytesToHex(mineResult.resourceId);
  } catch (error) {
    console.log('mine error: ', error);
    return null;
  }
}

// example usage
mineResourceId(
  'http://localhost:1633',
  'a valid stamp on your node' as BatchId,
  'overlay address of your node',
  'RANDOMTOPIC',
);
