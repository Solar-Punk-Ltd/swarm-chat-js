import { BatchId, Bee, Bytes, FeedIndex, Identifier, PrivateKey, Topic, UploadResult } from '@upcoming/bee-js';

import { remove0x } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { Logger } from '../utils/logger';

import { Bees, BeeSettings, BeeType, InitializedBee, InitializedBees, MultiBees } from './types';

/**
 * Utility class for Swarm chat operations including feed management,
 * user validation, and interaction with Bee and GSOC.
 */
export class SwarmChatUtils {
  private logger = Logger.getInstance();
  private errorHandler = new ErrorHandler();

  private UPLOAD_GSOC_TIMEOUT = 2000;

  constructor() {}

  public async writeUserFeedDataByIndex(params: {
    bees: InitializedBees;
    chatTopicBase: string;
    userAddress: string;
    index: number;
    privateKey: string;
    data: any;
  }): Promise<void> {
    const { bees, chatTopicBase, userAddress, privateKey, index, data } = params;

    const { bee, stamp } = this.getWriterBee(bees);

    const feedID = this.generateUserOwnedFeedId(chatTopicBase, userAddress);
    const topic = Topic.fromString(feedID);

    console.log('DEBUG: feedID write', topic.toString(), userAddress, index, feedID);
    const feedWriter = bee.makeFeedWriter(topic, new PrivateKey(privateKey));

    await feedWriter.uploadPayload(stamp, JSON.stringify(data), {
      index,
    });
  }

  public async fetchUserFeedDataByIndex(params: {
    bees: InitializedBees;
    chatTopicBase: string;
    userAddress: string;
    index: number;
    options?: { timeout?: number };
  }) {
    const { bees, chatTopicBase, userAddress, index, options = {} } = params;

    const timeout = options.timeout ?? 1500;

    const bee = this.getReaderBee(bees);

    const feedID = this.generateUserOwnedFeedId(chatTopicBase, userAddress);
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
   * Initializes Bee instances based on the provided Bees configuration.
   * @param bees - The Bees configuration object containing single or multiple bees.
   * @returns An object mapping each bee type (gsoc, reader, writer) to its initialized bee(s).
   * @throws If required bees or postage stamps are not provided.
   */
  public initBees(bees: Bees): InitializedBees {
    if (!bees.singleBee && !bees.multiBees) {
      throw new Error('No bees provided');
    }

    const initializedBees: InitializedBees = {};

    const initializeSingleBee = (beeConfig: BeeSettings): InitializedBee => {
      return {
        bee: new Bee(beeConfig.url),
        stamp: beeConfig.stamp,
        main: beeConfig.main,
      };
    };

    const initializeMultipleBees = (beeConfigs?: BeeSettings[]): InitializedBee[] => {
      if (!beeConfigs) {
        throw new Error('No bee configurations provided');
      }
      return beeConfigs.map((config) => {
        return {
          bee: new Bee(config.url),
          stamp: config.stamp,
          main: config.main,
        };
      });
    };

    if (bees.singleBee) {
      if (!bees.singleBee.stamp) {
        throw new Error('No postage stamp provided for the single bee');
      }
      return { single: initializeSingleBee(bees.singleBee) };
    }

    const types: (keyof MultiBees)[] = ['gsoc', 'reader', 'writer'];
    for (const type of types) {
      const beeGroup = bees.multiBees?.[type];
      if (!beeGroup) continue;

      if (beeGroup.singleBee) {
        initializedBees[type] = initializeSingleBee(beeGroup.singleBee);
      } else if (beeGroup.multiBees) {
        initializedBees[type] = initializeMultipleBees(beeGroup.multiBees);
      }
    }

    return initializedBees;
  }

  /**
   * Selects a Bee instance from the initialized bees based on the provided parameters.
   * @param initializedBees The object containing initialized bees.
   * @param type The type of bee to select (e.g., GSOC, READER, WRITER).
   * @param main If true, selects the main bee; otherwise, selects a random non-main bee.
   * @returns The selected Bee instance.
   * @throws If no suitable bee is found for the specified type.
   */
  public selectBee(initializedBees: InitializedBees, type: BeeType, main?: boolean): InitializedBee {
    const beeGroup = initializedBees[type];

    if (!beeGroup) {
      throw new Error(`No ${type} bees available`);
    }

    // multiple bees
    if (Array.isArray(beeGroup)) {
      if (main) {
        const mainBee = beeGroup.find((bee) => bee.main);
        if (mainBee) {
          return mainBee;
        }
      }

      const nonMainBees = beeGroup.filter((bee) => !bee.main);
      if (nonMainBees.length > 0) {
        const randomIndex = Math.floor(Math.random() * nonMainBees.length);
        return nonMainBees[randomIndex];
      }

      throw new Error(`No non-main ${type} bees available`);
    }

    // single bee
    if (beeGroup.bee) {
      return beeGroup;
    }

    throw new Error(`No ${type} bees available`);
  }

  public getMainGsocBee(bees: InitializedBees) {
    const { bee } = this.selectBee(bees, BeeType.GSOC, true);
    if (!bee) {
      throw new Error('Could not get main GSOC bee');
    }
    return bee;
  }

  public getGsocBee(bees: InitializedBees) {
    const { bee, stamp } = this.selectBee(bees, BeeType.GSOC);
    if (!bee) {
      throw new Error('Could not get GSOC bee');
    }
    if (!stamp) {
      throw new Error('Could not get valid gsoc stamp');
    }
    return { bee, stamp };
  }

  public getReaderBee(bees: InitializedBees) {
    const { bee } = this.selectBee(bees, BeeType.READER);
    if (!bee) {
      throw new Error('Could not get reader bee');
    }
    return bee;
  }

  public getWriterBee(bees: InitializedBees) {
    const { bee, stamp } = this.selectBee(bees, BeeType.WRITER);
    if (!bee) {
      throw new Error('Could not get writer bee');
    }
    if (!stamp) {
      throw new Error('Could not get valid writer stamp');
    }
    return { bee, stamp };
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

  public async uploadObjectToBee(bee: Bee, jsObject: object, stamp: BatchId): Promise<UploadResult | null> {
    try {
      const result = await bee.uploadData(stamp, JSON.stringify(jsObject), { redundancyLevel: 4 });
      console.log('DEBUG: result', result.reference.toString());
      return result;
    } catch (error) {
      this.errorHandler.handleError(error, 'Utils.uploadObjectToBee');
      return null;
    }
  }

  public async downloadObjectFromBee(bee: Bee, reference: string): Promise<any> {
    try {
      const result = await bee.downloadData(reference);
      return result.toJSON();
    } catch (error) {
      this.errorHandler.handleError(error, 'Utils.beeDownloadObject');
      return null;
    }
  }

  public async getLatestFeedIndex(bees: InitializedBees, chatTopicBase: string, address: string) {
    try {
      const readerBee = this.getReaderBee(bees);

      const feedID = this.generateUserOwnedFeedId(chatTopicBase, address);
      const topic = Topic.fromString(feedID);

      const feedReader = readerBee.makeFeedReader(topic, address);
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

  /** DEPRECATED
   * Subscribe to GSOC messages for a topic and resource ID.
   * @param url The Bee URL.
   * @param topic The chat topic.
   * @param resourceId The resource ID for subscription.
   * @param callback Callback to handle incoming messages.
   * @returns The subscription instance or null if an error occurs.
   */
  public subscribeToGsoc(
    bees: InitializedBees,
    gsocTopic: string,
    resourceId: string,
    callback: (gsocMessage: Bytes) => void,
  ) {
    if (!resourceId) throw new Error('ResourceID was not provided!');

    const bee = this.getMainGsocBee(bees);

    const key = new PrivateKey(resourceId);
    const identifier = Identifier.fromString(gsocTopic);

    const gsocSub = bee.gsocSubscribe(key.publicKey().address(), identifier, {
      onMessage: callback,
      onError: this.logger.error,
    });

    return gsocSub;
  }

  /**
   * Fetch the latest GSOC message for a specific topic and resource ID.
   * @param url The Bee URL.
   * @param topic The chat topic.
   * @param resourceId The resource ID for the message.
   * @returns The latest GSOC message
   */
  public async fetchLatestChatMessage(bees: InitializedBees, chatTopic: string, publicAddress: string): Promise<any> {
    const { bee } = this.getGsocBee(bees);

    const reader = bee.makeFeedReader(Topic.fromString(chatTopic), remove0x(publicAddress));
    const res = await reader.downloadPayload();

    return res.payload.toJSON();
  }

  public async fetchChatMessage(
    bees: InitializedBees,
    chatTopic: string,
    publicAddress: string,
    index: string,
  ): Promise<any> {
    const { bee } = this.getGsocBee(bees);

    const reader = bee.makeFeedReader(Topic.fromString(chatTopic), remove0x(publicAddress));
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
  public async sendMessageToGsoc(
    bees: InitializedBees,
    topic: string,
    resourceId: string,
    message: string,
  ): Promise<void> {
    this.logger.debug('sendMessageToGsoc entry CALLED');
    if (!resourceId) throw new Error('ResourceID was not provided!');

    const { bee, stamp } = this.getGsocBee(bees);

    const signer = new PrivateKey(resourceId);
    const identifier = Identifier.fromString(topic);

    await bee.gsocSend(stamp, signer, identifier, message, undefined, {
      timeout: this.UPLOAD_GSOC_TIMEOUT,
    });

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
