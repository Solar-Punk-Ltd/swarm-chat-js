import { BatchId, Bee, UploadResult } from '@ethersphere/bee-js';
import { InformationSignal } from '@solarpunkltd/gsoc';
import { SingleOwnerChunk } from '@solarpunkltd/gsoc/dist/soc';
import { HexString } from '@solarpunkltd/gsoc/dist/types';

import { ErrorHandler } from '../utils/error';
import { Logger } from '../utils/logger';

import { HEX_RADIX } from './constants';
import { Bees, BeeSettings, BeeType, EthAddress, InitializedBee, InitializedBees, MultiBees } from './types';

/**
 * Utility class for Swarm chat operations including feed management,
 * user validation, and interaction with Bee and GSOC.
 */
export class SwarmChatUtils {
  private logger = new Logger();
  private errorHandler = new ErrorHandler(this.logger);

  private UPLOAD_GSOC_TIMEOUT = 2000;

  constructor() {}

  /**
   * Generate a feed ID for storing user data based on the topic.
   * @param topic The topic identifier.
   * @returns The generated feed ID.
   */
  public generateUsersFeedId(topic: string): string {
    return `${topic}_EthercastChat_Users`;
  }

  /**
   * Generate a user-specific feed ID based on topic and user address.
   * @param topic The topic identifier.
   * @param userAddress The user’s Ethereum address.
   * @returns The generated user-specific feed ID.
   */
  public generateUserOwnedFeedId(topic: string, userAddress: EthAddress): string {
    return `${topic}_EthercastChat_${userAddress}`;
  }

  public async writeUserFeedDataByIndex(params: {
    bees: InitializedBees;
    rawTopic: string;
    userAddress: EthAddress;
    index: number;
    privateKey: string;
    data: any;
  }): Promise<any> {
    const { bee, stamp } = this.getWriterBee(params.bees);

    const feedID = this.generateUserOwnedFeedId(params.rawTopic, params.userAddress);
    const feedTopicHex = bee.makeFeedTopic(feedID);
    const feedWriter = bee.makeFeedWriter('sequence', feedTopicHex, params.privateKey);

    const msgData = await this.retryAwaitableAsync(() => this.uploadObjectToBee(bee, params.data, stamp));
    if (!msgData) throw new Error('Uploaded message data is empty');

    await feedWriter.upload(stamp, msgData.reference, {
      index: params.index,
    });
  }

  public async fetchUserFeedDataByIndex(params: {
    bees: InitializedBees;
    rawTopic: string;
    userAddress: EthAddress;
    index: number;
    options?: { timeout?: number };
  }) {
    const { bees, rawTopic, userAddress, index, options = {} } = params;
    const timeout = options.timeout ?? 1500;

    const bee = this.getReaderBee(bees);
    const chatID = this.generateUserOwnedFeedId(rawTopic, userAddress);
    const topic = bee.makeFeedTopic(chatID);
    const feedReader = bee.makeFeedReader('sequence', topic, userAddress, { timeout });

    const recordPointer = await feedReader.download({ index });
    const data = await bee.downloadData(recordPointer.reference, {
      headers: { 'Swarm-Redundancy-Level': '0' },
    });

    return JSON.parse(new TextDecoder().decode(data));
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

  /**
   * Upload an object to the Bee storage.
   * @param bee The Bee instance.
   * @param jsObject The object to upload.
   * @param stamp The postage stamp.
   * @returns The upload result or null if an error occurs.
   */
  public async uploadObjectToBee(bee: Bee, jsObject: object, stamp: BatchId): Promise<UploadResult | null> {
    try {
      const result = await bee.uploadData(stamp as any, this.serializeRecord(jsObject), { redundancyLevel: 4 });
      return result;
    } catch (error) {
      this.errorHandler.handleError(error, 'Utils.uploadObjectToBee');
      return null;
    }
  }

  public async downloadObjectFromBee(bee: Bee, reference: string): Promise<any> {
    try {
      const result = await bee.downloadData(reference);
      return result.json();
    } catch (error) {
      this.errorHandler.handleError(error, 'Utils.beeDownloadObject');
      return null;
    }
  }

  /**
   * Retrieve the latest feed index for a topic and address.
   * @param bee The Bee instance.
   * @param topic The topic for the feed.
   * @param address The address owning the feed.
   * @returns The latest and next feed indexes.
   */
  public async getLatestFeedIndex(bee: Bee, topic: string, address: EthAddress) {
    try {
      const feedReader = bee.makeFeedReader('sequence', topic, address);
      const feedEntry = await feedReader.download();
      const latestIndex = parseInt(feedEntry.feedIndex.toString(), HEX_RADIX);
      const nextIndex = parseInt(feedEntry.feedIndexNext, HEX_RADIX);

      return { latestIndex, nextIndex };
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return { latestIndex: -1, nextIndex: 0 };
      }
      throw error;
    }
  }

  /**
   * Subscribe to GSOC messages for a topic and resource ID.
   * @param url The Bee URL.
   * @param stamp The postage stamp.
   * @param topic The chat topic.
   * @param resourceId The resource ID for subscription.
   * @param callback Callback to handle incoming messages.
   * @returns The subscription instance or null if an error occurs.
   */
  public subscribeToGsoc(
    url: string,
    topic: string,
    resourceId: HexString<number>,
    callback: (gsocMessage: string) => void,
  ) {
    if (!resourceId) throw new Error('ResourceID was not provided!');

    const informationSignal = new InformationSignal(url, {
      consensus: {
        id: `SwarmDecentralizedChat::${topic}`,
        assertRecord: (_input) => {
          // We handle validation at our side
          return true;
        },
      },
    });

    const gsocSub = informationSignal.subscribe(
      {
        onMessage: callback,
        onError: this.logger.error,
      },
      resourceId,
    );

    return gsocSub;
  }

  public async fetchLatestGsocMessage(url: string, topic: string, resourceId: HexString<number>): Promise<any> {
    if (!resourceId) throw new Error('ResourceID was not provided!');

    const informationSignal = new InformationSignal(url, {
      consensus: {
        id: `SwarmDecentralizedChat::${topic}`,
        assertRecord: (_input) => {
          // We handle validation at our side
          return true;
        },
      },
    });

    const gsocData = await informationSignal.getLatestGsocData(resourceId);

    return gsocData.json();
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
    url: string,
    topic: string,
    stamp: BatchId,
    resourceId: HexString<number>,
    message: string,
  ): Promise<SingleOwnerChunk | undefined> {
    if (!resourceId) throw new Error('ResourceID was not provided!');

    const informationSignal = new InformationSignal(url, {
      consensus: {
        id: `SwarmDecentralizedChat::${topic}`,
        assertRecord: (_input) => {
          // We handle validation at our side
          return true;
        },
      },
    });

    const uploadedSoc = await informationSignal.write(message, resourceId, stamp, {
      timeout: this.UPLOAD_GSOC_TIMEOUT,
    });

    this.logger.debug('sendMessageToGsoc - CALLED');
    return uploadedSoc;
  }

  /**
   * Serialize a graffiti record to a Uint8Array.
   * @param record The graffiti record to serialize.
   * @returns The serialized record.
   */
  private serializeRecord(record: Record<any, any>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(record));
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
