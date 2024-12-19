import { BatchId, Bee, BeeRequestOptions, Signer, UploadResult, Utils } from '@ethersphere/bee-js';
import { InformationSignal } from '@solarpunkltd/gsoc';
import { SingleOwnerChunk } from '@solarpunkltd/gsoc/dist/soc';
import { HexString } from '@solarpunkltd/gsoc/dist/types';
import { BytesLike, ethers, hexlify, Wallet } from 'ethers';

import { CONSENSUS_ID, HEX_RADIX } from './constants';
import {
  Bees,
  BeeSettings,
  BeeType,
  ErrorObject,
  EthAddress,
  InitializedBee,
  InitializedBees,
  MultiBees,
  Sha3Message,
} from './types';

/**
 * Utility class for Swarm chat operations including feed management,
 * user validation, and interaction with Bee and GSOC.
 */
export class SwarmChatUtils {
  private handleError: (errObject: ErrorObject) => void;
  private UPLOAD_GSOC_TIMEOUT = 2000;

  constructor(handleError: (errObject: ErrorObject) => void) {
    this.handleError = handleError;
  }

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

  /**
   * Validate the structure and signature of a user object.
   * @param user The user object to validate.
   * @returns True if valid, false otherwise.
   */
  public validateUserObject(user: any): boolean {
    try {
      if (typeof user.username !== 'string') throw 'username should be a string';
      if (typeof user.address !== 'string') throw 'address should be a string';
      if (typeof user.timestamp !== 'number') throw 'timestamp should be number';
      if (typeof user.signature !== 'string') throw 'signature should be a string';

      const allowedProperties = ['username', 'address', 'timestamp', 'signature', 'index'];
      const extraProperties = Object.keys(user).filter((key) => !allowedProperties.includes(key));
      if (extraProperties.length > 0) {
        throw `Unexpected properties found: ${extraProperties.join(', ')}`;
      }

      const message = {
        username: user.username,
        address: user.address,
        timestamp: user.timestamp,
      };

      const returnedAddress = ethers.verifyMessage(JSON.stringify(message), user.signature);
      if (returnedAddress !== user.address) throw 'Signature verification failed!';

      return true;
    } catch (error) {
      this.handleError({
        error: error as unknown as Error,
        context: 'This User object is not correct',
        throw: false,
      });
      return false;
    }
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
            console.info(`Retrying... Attempts left: ${retries}. Error: ${error.message}`);
            setTimeout(() => {
              this.retryAwaitableAsync(fn, retries - 1, delay)
                .then(resolve)
                .catch(reject);
            }, delay);
          } else {
            this.handleError({
              error: error as unknown as Error,
              context: `Failed after ${retries} initial attempts. Last error: ${error.message}`,
              throw: false,
            });
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
      const result = await bee.uploadData(stamp as any, this.serializeGraffitiRecord(jsObject), { redundancyLevel: 4 });
      return result;
    } catch (error) {
      this.handleError({
        error: error as unknown as Error,
        context: `uploadObjectToBee`,
        throw: false,
      });
      return null;
    }
  }

  /**
   * Create a feed writer for graffiti based on a topic.
   * @param bee The Bee instance.
   * @param topic The topic for the feed.
   * @param options Additional Bee request options.
   * @returns The feed writer instance.
   */
  public graffitiFeedWriterFromTopic(bee: Bee, topic: string, options?: BeeRequestOptions) {
    const { consensusHash, graffitiSigner } = this.generateGraffitiFeedMetadata(topic);
    return bee.makeFeedWriter('sequence', consensusHash, graffitiSigner, options);
  }

  /**
   * Create a feed reader for graffiti based on a topic.
   * @param bee The Bee instance.
   * @param topic The topic for the feed.
   * @param options Additional Bee request options.
   * @returns The feed reader instance.
   */
  public graffitiFeedReaderFromTopic(bee: Bee, topic: string, options?: BeeRequestOptions) {
    const { consensusHash, graffitiSigner } = this.generateGraffitiFeedMetadata(topic);
    return bee.makeFeedReader('sequence', consensusHash, graffitiSigner.address, options);
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
    try {
      if (!resourceId) throw 'ResourceID was not provided!';

      const informationSignal = new InformationSignal(url, {
        consensus: {
          id: `SwarmDecentralizedChat::${topic}`,
          assertRecord: (rawText) => {
            const receivedObject = JSON.parse(rawText as unknown as string);
            const isValid = this.validateUserObject(receivedObject);
            return isValid;
          },
        },
      });

      const gsocSub = informationSignal.subscribe(
        {
          onMessage: callback,
          onError: console.log,
        },
        resourceId,
      );

      return gsocSub;
    } catch (error) {
      this.handleError({
        error: error as unknown as Error,
        context: `subscribeToGSOC`,
        throw: true,
      });
      return null;
    }
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
    stamp: BatchId,
    topic: string,
    resourceId: HexString<number>,
    message: string,
  ): Promise<SingleOwnerChunk | undefined> {
    try {
      if (!resourceId) throw 'ResourceID was not provided!';

      const informationSignal = new InformationSignal(url, {
        consensus: {
          id: `SwarmDecentralizedChat::${topic}`,
          assertRecord: (_input) => {
            // TODO: Implement this
            return true;
          },
        },
        postage: stamp,
      });

      const uploadedSoc = await informationSignal.write(message, resourceId, {
        timeout: this.UPLOAD_GSOC_TIMEOUT,
      });

      return uploadedSoc;
    } catch (error) {
      this.handleError({
        error: error as unknown as Error,
        context: `sendMessageToGSOC`,
        throw: false,
      });
    }
  }

  /**
   * Generate a private key for graffiti using a resource.
   * @param resource The resource used to generate the key.
   * @returns The private key as a byte array.
   */
  private getConsensualPrivateKey(resource: Sha3Message): Uint8Array {
    if (Utils.isHexString(resource) && resource.length === 64) {
      return Utils.hexToBytes(resource);
    }
    return Utils.keccak256Hash(resource);
  }

  /**
   * Create a wallet from a consensual private key.
   * @param consensualPrivateKey The private key to create the wallet.
   * @returns The created wallet.
   */
  private getGraffitiWallet(consensualPrivateKey: BytesLike): Wallet {
    const privateKeyBuffer = hexlify(consensualPrivateKey);
    return new Wallet(privateKeyBuffer);
  }

  /**
   * Serialize a graffiti record to a Uint8Array.
   * @param record The graffiti record to serialize.
   * @returns The serialized record.
   */
  private serializeGraffitiRecord(record: Record<any, any>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(record));
  }

  /**
   * Generate metadata for graffiti feed including consensus hash and signer.
   * @param topic The topic for the feed.
   * @returns The feed metadata.
   */
  private generateGraffitiFeedMetadata(topic: string) {
    const roomId = this.generateUsersFeedId(topic);
    const privateKey = this.getConsensualPrivateKey(roomId);
    const wallet = this.getGraffitiWallet(privateKey);

    const graffitiSigner: Signer = {
      address: Utils.hexToBytes(wallet.address.slice(2)),
      sign: async (data: any) => {
        return await wallet.signMessage(data);
      },
    };

    const consensusHash = Utils.keccak256Hash(CONSENSUS_ID);

    return {
      consensusHash,
      graffitiSigner,
    };
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
