import { Bytes, FeedIndex, Identifier, PrivateKey, Stamper, Topic } from '@ethersphere/bee-js';
import { Binary, MerkleTree } from 'cafe-utility';

import { ChatSettingsSwarm, ChatSettingsUser, MessageData } from '../interfaces';
import { makeContentAddressedChunk, makeFeedIdentifier, makeSingleOwnerChunk } from '../utils/bee';
import { remove0x } from '../utils/common';
import { ErrorHandler } from '../utils/error';

export class SwarmChatUtils {
  // TODO: big enough now, but it should represent the depth of the stamp
  private depth = 26;
  private errorHandler = ErrorHandler.getInstance();

  private UPLOAD_GSOC_TIMEOUT = 2000;

  constructor(private userDetails: ChatSettingsUser, private swarmSettings: ChatSettingsSwarm) {}

  public generateUserOwnedFeedId(topic: string, userAddress: string) {
    return `${topic}_EthercastChat_${userAddress}`;
  }

  public isNotFoundError(error: any): boolean {
    // TODO: why bee-js do this?
    // status is undefined in the error object
    // Determines if the error is about 'Not Found'
    return (
      error.stack.includes('404') ||
      error.message.includes('Not Found') ||
      error.message.includes('404') ||
      error.code === 404
    );
  }

  public async writeOwnFeedDataByIndex(index: number, data: any) {
    const { enveloped, stamp } = this.swarmSettings;

    if (!enveloped) {
      await this.writeOwnFeedDataByIndexOwned(index, data);
    } else if (stamp) {
      await this.writeOwnFeedDataByIndexEnvelope(index, data);
    } else {
      throw new Error('Enveloped mode is enabled, but stamp is not provided');
    }
  }

  private async writeOwnFeedDataByIndexOwned(index: number, data: any): Promise<void> {
    const { bee, stamp, chatTopic } = this.swarmSettings;
    const { privateKey, ownAddress } = this.userDetails;

    const feedID = this.generateUserOwnedFeedId(chatTopic, ownAddress);
    const topic = Topic.fromString(feedID);

    const feedWriter = bee.makeFeedWriter(topic, new PrivateKey(privateKey));

    await feedWriter.uploadPayload(stamp, JSON.stringify(data), {
      index,
    });
  }

  // TODO: support for wrapped chunks
  private async writeOwnFeedDataByIndexEnvelope(index: number, data: string): Promise<string> {
    const { bee, stamp, chatTopic } = this.swarmSettings;
    const { privateKey, ownAddress } = this.userDetails;

    const signer = new PrivateKey(privateKey);
    const stamper = Stamper.fromBlank(privateKey, stamp, this.depth);

    const feedID = this.generateUserOwnedFeedId(chatTopic, ownAddress);
    const topic = Topic.fromString(feedID);
    const identifier = makeFeedIdentifier(topic, index);

    const cac = makeContentAddressedChunk(data);
    const soc = makeSingleOwnerChunk(cac, identifier, signer);

    // TODO: workarounds for bee-js envleope type bugs
    const stampReadyChunk = {
      hash: () => soc.address.toUint8Array(),
    };
    const envelope = stamper.stamp(stampReadyChunk as any) as any;

    const { upload } = bee.makeSOCWriter(signer);
    const payload = Bytes.fromUtf8(data);
    const result = await upload(envelope, identifier, payload.toUint8Array());

    return result.reference.toHex();
  }

  public orderMessages(messages: any[]): any[] {
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  public async downloadObjectFromBee(reference: string): Promise<any | null> {
    try {
      const { bee } = this.swarmSettings;
      const data = await bee.downloadData(reference);
      return data ? data.toJSON() : null;
    } catch (error) {
      this.errorHandler.handleError(error, 'Utils.downloadObjectFromBee');
      return null;
    }
  }

  public async uploadObjectToBee(jsObject: object): Promise<string | null> {
    const { enveloped, stamp } = this.swarmSettings;

    if (!enveloped) {
      return this.uploadObjectToBeeOwn(jsObject);
    } else if (stamp) {
      return this.uploadObjectToBeeEnvelope(jsObject);
    } else {
      throw new Error('Enveloped mode is enabled, but stamp is not provided');
    }
  }

  private async uploadObjectToBeeOwn(jsObject: object): Promise<string | null> {
    try {
      const { bee, stamp } = this.swarmSettings;
      const result = await bee.uploadData(stamp, JSON.stringify(jsObject), { redundancyLevel: 4 });
      return result.reference.toString();
    } catch (error) {
      this.errorHandler.handleError(error, 'Utils.uploadObjectToBee');
      return null;
    }
  }

  private async uploadObjectToBeeEnvelope(jsObject: object): Promise<string | null> {
    try {
      const { bee, stamp } = this.swarmSettings;
      const { privateKey } = this.userDetails;

      const stamper = Stamper.fromBlank(privateKey, stamp, this.depth);
      const payload = Bytes.fromUtf8(JSON.stringify(jsObject));

      const tree = new MerkleTree(async (chunk) => {
        await bee.uploadChunk(stamper.stamp(chunk), chunk.build());
      });

      await tree.append(payload.toUint8Array());

      const rootChunk = await tree.finalize();

      return Binary.uint8ArrayToHex(rootChunk.hash());
    } catch (error) {
      this.errorHandler.handleError(error, 'Utils.uploadObjectToBee');
      return null;
    }
  }

  public async getOwnLatestFeedIndex() {
    try {
      const { bee, chatTopic } = this.swarmSettings;
      const { ownAddress } = this.userDetails;

      const feedID = this.generateUserOwnedFeedId(chatTopic, ownAddress);
      const topic = Topic.fromString(feedID);

      const feedReader = bee.makeFeedReader(topic, ownAddress);
      const feedEntry = await feedReader.downloadPayload();

      const latestIndex = Number(feedEntry.feedIndex.toBigInt());
      // TODO: use feedNextIndex after bee-js patch
      const nextIndex = latestIndex + 1;

      return { latestIndex, nextIndex };
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return { latestIndex: -1, nextIndex: 0 };
      }
      throw error;
    }
  }

  public async fetchLatestChatMessage(): Promise<{ message: MessageData; index: FeedIndex }> {
    const { bee, chatTopic, chatAddress } = this.swarmSettings;

    const reader = bee.makeFeedReader(Topic.fromString(chatTopic), remove0x(chatAddress));
    const res = await reader.downloadPayload();

    return { message: res.payload.toJSON() as MessageData, index: res.feedIndex };
  }

  public async fetchChatMessage(index: FeedIndex): Promise<any> {
    const { bee, chatTopic, chatAddress } = this.swarmSettings;

    const reader = bee.makeFeedReader(Topic.fromString(chatTopic), remove0x(chatAddress));
    const res = await reader.downloadPayload({ index });

    return res.payload.toJSON();
  }

  public async sendMessageToGsoc(message: string): Promise<void> {
    const { enveloped, stamp } = this.swarmSettings;

    if (!enveloped) {
      await this.sendMessageToGsocOwn(message);
    } else if (stamp) {
      await this.sendMessageToGsocEnvelope(message);
    } else {
      throw new Error('Enveloped mode is enabled, but stamp is not provided');
    }
  }

  public async rawSocDownload(owner: string, id: string): Promise<any> {
    const { beeUrl } = this.swarmSettings;

    const response = await fetch(`${beeUrl}/soc/${owner}/${id}`, {
      headers: {
        'swarm-chunk-retrieval-timeout': '2000ms',
      },
    });

    if (!response.ok) {
      const error = new Error(`Failed to fetch: ${owner}/${id} [${response.status}]`);
      (error as any).status = response.status;
      throw error;
    }

    return response.text();
  }

  private async sendMessageToGsocOwn(message: string): Promise<void> {
    const { bee, stamp, gsocTopic, gsocResourceId } = this.swarmSettings;

    const signer = new PrivateKey(gsocResourceId);
    const identifier = Identifier.fromString(gsocTopic);

    const data = Bytes.fromUtf8(message);

    const { upload } = bee.makeSOCWriter(signer, {
      timeout: this.UPLOAD_GSOC_TIMEOUT,
    });

    await upload(stamp, identifier, data.toUint8Array());
  }

  private async sendMessageToGsocEnvelope(message: string): Promise<void> {
    const { bee, stamp, gsocTopic, gsocResourceId } = this.swarmSettings;
    const { privateKey } = this.userDetails;

    const stamper = Stamper.fromBlank(privateKey, stamp, this.depth);

    const signer = new PrivateKey(gsocResourceId);
    const identifier = Identifier.fromString(gsocTopic);

    const data = Bytes.fromUtf8(message);

    const cac = makeContentAddressedChunk(data.toUint8Array());
    const soc = makeSingleOwnerChunk(cac, identifier, signer);
    const stampReadyChunk = {
      hash: () => soc.address.toUint8Array(),
    };

    // TODO: workarounds for bee-js envleope type bugs
    const envelope = stamper.stamp(stampReadyChunk as any) as any;

    const { upload } = bee.makeSOCWriter(signer, {
      timeout: this.UPLOAD_GSOC_TIMEOUT,
    });

    await upload(envelope, identifier, data.toUint8Array());
  }
}
