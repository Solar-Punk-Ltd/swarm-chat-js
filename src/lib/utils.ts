import { Bytes, FeedIndex, Identifier, PrivateKey, Stamper, Topic, UploadResult } from '@ethersphere/bee-js';
import { Binary, MerkleTree } from 'cafe-utility';

import { makeContentAddressedChunk, makeFeedIdentifier, makeSingleOwnerChunk } from '../utils/bee';
import { remove0x } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { Logger } from '../utils/logger';

import { ChatSettingsSwarm, ChatSettingsUser } from './types';

/**
 * Utility class for Swarm chat operations including feed management,
 * user validation, and interaction with Bee and GSOC.
 */
export class SwarmChatUtils {
  // TODO: big enough now, but it should represent the depth of the stamp
  private depth = 24;
  private logger = Logger.getInstance();
  private errorHandler = new ErrorHandler();

  private UPLOAD_GSOC_TIMEOUT = 2000;

  constructor(private userDetails: ChatSettingsUser, private swarmSettings: ChatSettingsSwarm) {}

  public async writeOwnFeedDataByIndex(index: number, data: any): Promise<void> {
    const { bee, stamp, chatTopic } = this.swarmSettings;
    const { privateKey, ownAddress } = this.userDetails;

    const feedID = this.generateUserOwnedFeedId(chatTopic, ownAddress);
    const topic = Topic.fromString(feedID);

    console.log('DEBUG: feedID write', topic.toString(), ownAddress, index, feedID);
    const feedWriter = bee.makeFeedWriter(topic, new PrivateKey(privateKey));

    await feedWriter.uploadPayload(stamp, JSON.stringify(data), {
      index,
    });
  }

  // TODO: support for wrapped chunks
  public async writeOwnFeedDataByIndexV2(index: number, data: string): Promise<string> {
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

  public async fetchUserFeedDataByIndex(userAddress: string, index: number, options?: { timeout?: number }) {
    const { bee, chatTopic } = this.swarmSettings;

    const timeout = options?.timeout ?? 1500;

    const feedID = this.generateUserOwnedFeedId(chatTopic, userAddress);
    const topic = Topic.fromString(feedID);
    console.log('DEBUG: feedID read', topic.toString(), userAddress, index, feedID);

    const feedReader = bee.makeFeedReader(topic, userAddress, {
      timeout,
    });

    const data = await feedReader.downloadPayload({
      index,
    });

    console.log(data.payload.toHex());
    console.log(data.payload.toUtf8());

    return data.payload.toJSON();
  }

  /**
   * Sort messages by their timestamp in ascending order.
   * @param messages The list of messages to sort.
   * @returns The sorted list of messages.
   */
  public orderMessages(messages: any[]): any[] {
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Retry an asynchronous operation with exponential backoff.
   * @param fn The function to retry.
   * @param retries The number of retries.
   * @param delay The delay between retries in milliseconds.
   * @returns The result of the operation.
   */
  public async retryAwaitableAsync<T>(fn: () => Promise<T>, retries: number = 3, delay: number = 250): Promise<T> {
    return new Promise((resolve, reject) => {
      fn()
        .then(resolve)
        .catch((error) => {
          if (retries > 0) {
            this.logger.info(`Retrying... Attempts left: ${retries}. Error: ${error.message}`);
            setTimeout(() => {
              this.retryAwaitableAsync(fn, retries - 1, delay)
                .then(resolve)
                .catch(reject);
            }, delay);
          } else {
            this.errorHandler.handleError(error, 'Utils.retryAwaitableAsync');
            reject(error);
          }
        });
    });
  }

  public async uploadObjectToBee(jsObject: object): Promise<UploadResult | null> {
    try {
      const { bee, stamp } = this.swarmSettings;
      const result = await bee.uploadData(stamp, JSON.stringify(jsObject), { redundancyLevel: 4 });
      console.log('DEBUG: result', result.reference.toString());
      return result;
    } catch (error) {
      this.errorHandler.handleError(error, 'Utils.uploadObjectToBee');
      return null;
    }
  }

  public async uploadObjectToBeeV2(jsObject: object): Promise<string | null> {
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

  public async downloadObjectFromBee(reference: string): Promise<any> {
    try {
      const { bee } = this.swarmSettings;
      const result = await bee.downloadData(reference);
      return result.toJSON();
    } catch (error) {
      this.errorHandler.handleError(error, 'Utils.beeDownloadObject');
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

      console.log('DEBUG: getLatestFeedIndex', latestIndex, nextIndex);

      return { latestIndex, nextIndex };
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return { latestIndex: -1, nextIndex: 0 };
      }
      throw error;
    }
  }

  /**
   * Fetch the latest GSOC message for a specific topic and resource ID.
   * @param url The Bee URL.
   * @param topic The chat topic.
   * @param resourceId The resource ID for the message.
   * @returns The latest GSOC message
   */
  public async fetchLatestChatMessage(): Promise<any> {
    const { bee, chatTopic, chatAddress } = this.swarmSettings;

    const reader = bee.makeFeedReader(Topic.fromString(chatTopic), remove0x(chatAddress));
    const res = await reader.downloadPayload();

    return res.payload.toJSON();
  }

  public async fetchChatMessage(index: string): Promise<any> {
    const { bee, chatTopic, chatAddress } = this.swarmSettings;

    const reader = bee.makeFeedReader(Topic.fromString(chatTopic), remove0x(chatAddress));
    const res = await reader.downloadPayload({ index: FeedIndex.fromBigInt(BigInt(`0x${index}`)) });

    return res.payload.toJSON();
  }

  /**
   * Send a message to GSOC for a specific topic and resource ID.
   * @param url The Bee URL.
   * @param stamp The postage stamp.
   * @param topic The chat topic.
   * @param resourceId The resource ID for the message.
   * @param message The message to send.
   * @returns The uploaded SingleOwnerChunk or undefined if an error occurs.
   */
  public async sendMessageToGsoc(message: string): Promise<void> {
    this.logger.debug('sendMessageToGsoc entry CALLED');

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

    this.logger.debug('sendMessageToGsoc end CALLED');
  }
  /**
   * Generate a user-specific feed ID based on topic and user address.
   * @param topic The topic identifier.
   * @param userAddress The user’s Ethereum address.
   * @returns The generated user-specific feed ID.
   */
  private generateUserOwnedFeedId(topic: string, userAddress: string) {
    return `${topic}_EthercastChat_${userAddress}`;
  }

  /**
   * Determine if an error is related to a 404 Not Found response.
   * @param error The error object.
   * @returns True if it is a Not Found error, false otherwise.
   */
  private isNotFoundError(error: any): boolean {
    // TODO: why bee-js do this?
    // status is undefined in the error object
    // Determines if the error is about 'Not Found'
    return error.stack.includes('404') || error.message.includes('Not Found') || error.message.includes('404');
  }
}
