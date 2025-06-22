import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { isUserComment, readCommentsInRange } from '@solarpunkltd/comment-system';

import { MessageData, MessageStateRef, MessageType, StatefulMessage } from '../interfaces/message';
import { sleep } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { validateGsocMessage, validateMessageState } from '../utils/validation';

import { COMMENTS_TO_READ, EVENTS } from './constants';
import { SwarmChatUtils } from './utils';

export class SwarmHistory {
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private processedRefs: Set<string> = new Set();
  private refRetryCount: Map<string, number> = new Map();
  private bannedRefs: Set<string> = new Set();

  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000;

  constructor(private utils: SwarmChatUtils, private emitter: EventEmitter) {}

  public async init(isComment: boolean = false) {
    try {
      const { data, index } = await this.utils.fetchLatestChatMessage();

      try {
        await this.initMessageState(data, isComment);
      } catch (error) {
        this.errorHandler.handleError(error, 'SwarmHistory.initMessageState');
      }

      return index;
    } catch (error) {
      this.errorHandler.handleError(error, 'SwarmHistory.init');
      return FeedIndex.fromBigInt(0n);
    }
  }

  public async initMessageState(statefulMessage: StatefulMessage, isComment: boolean) {
    try {
      if (isComment) {
        if (!isUserComment(statefulMessage)) {
          this.logger.warn('Invalid comment during message state initialization');
        }

        return;
      }

      if (!validateGsocMessage(statefulMessage)) {
        this.logger.warn('Invalid GSOC message during message state initialization');
        return;
      }

      if (!statefulMessage.messageStateRefs || statefulMessage.messageStateRefs.length === 0) {
        this.logger.debug('No message state refs to initialize');
        return;
      }

      const latestRef = this.findLatestRef(statefulMessage.messageStateRefs);
      if (!latestRef) {
        this.logger.warn('No valid latest reference found');
        return;
      }

      this.logger.debug('Initializing message state with latest ref:', latestRef.reference);

      await this.processMessageRefWithRetry(latestRef.reference);
    } catch (error: any) {
      if (this.utils.isNotFoundError(error)) {
        this.logger.debug('No latest GSOC message found for message state initialization');
        return;
      }
      this.errorHandler.handleError(error, 'SwarmHistory.init');
    }
  }

  // todo: refactor startindex usage
  public async fetchPreviousMessageState(startIndex?: bigint) {
    if (startIndex !== undefined) {
      return this.fetchPreviousCommentState(startIndex);
    }

    return this.fetchPreviousChatState();
  }

  // TODO: refactor with processMessageRefWithRetry
  private async fetchPreviousCommentState(startIndex: bigint) {
    this.logger.info('fetchPreviousCommentState startIndex:', startIndex.toString());
    if (startIndex <= 0n) {
      return;
    }

    const newStartIndex = startIndex > COMMENTS_TO_READ ? startIndex - COMMENTS_TO_READ : 0n;
    this.logger.info('fetchPreviousCommentState this.startFeedIdx:', startIndex);
    this.logger.info('fetchPreviousCommentState newStartIndex:', newStartIndex);

    // todo: debug
    this.logger.info('Fetching previous messages from: ', newStartIndex.toString(), ' to: ', startIndex.toString());

    const comments = await readCommentsInRange(FeedIndex.fromBigInt(newStartIndex), FeedIndex.fromBigInt(startIndex), {
      identifier: Topic.fromString(this.utils.getSwarmSettings().chatTopic).toString(),
      address: this.utils.getSwarmSettings().chatAddress,
      beeApiUrl: this.utils.getSwarmSettings().beeUrl,
    });

    if (!comments) {
      return;
    }

    for (let ix = 0; ix < comments.length; ix++) {
      const c = comments[ix];

      if (!isUserComment(c)) {
        // todo: debug
        this.logger.warn('Invalid user comment detected:', c);
        continue;
      }

      const message = this.utils.transformComment(c, Number(startIndex - BigInt(ix)), MessageType.TEXT);

      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, message);
    }

    return newStartIndex;
  }

  private async fetchPreviousChatState() {
    const { data: statefulMessage } = await this.utils.fetchLatestChatMessage();

    if (!statefulMessage.messageStateRefs || statefulMessage.messageStateRefs.length === 0) {
      this.logger.debug('No message state refs to fetch');
      return;
    }

    const sortedRefs = [...statefulMessage.messageStateRefs].sort((a, b) => a.timestamp - b.timestamp);

    for (const ref of sortedRefs) {
      if (!this.processedRefs.has(ref.reference) && !this.bannedRefs.has(ref.reference)) {
        this.logger.debug('Fetching previous message ref:', ref.reference);
        await this.processMessageRefWithRetry(ref.reference);
      }
    }
  }

  private findLatestRef(refs: MessageStateRef[]): MessageStateRef | null {
    if (refs.length === 0) return null;

    return refs.reduce((latest, current) => (current.timestamp > latest.timestamp ? current : latest));
  }

  private async processMessageRefWithRetry(ref: string): Promise<void> {
    if (this.processedRefs.has(ref) || this.bannedRefs.has(ref)) {
      return;
    }

    try {
      await this.processMessageRef(ref);
    } catch (error) {
      await this.handleRefError(ref, error);
    }
  }

  private async processMessageRef(ref: string): Promise<void> {
    const messageState = (await this.utils.downloadObjectFromBee(ref)) as MessageData[];

    const isValid = validateMessageState(messageState);
    if (!isValid) {
      throw new Error(`Invalid message state for ref: ${ref}`);
    }

    this.processedRefs.add(ref);
    this.refRetryCount.delete(ref);

    for (const message of messageState) {
      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, message);
    }
  }

  private async handleRefError(ref: string, error: any): Promise<void> {
    const currentRetries = this.refRetryCount.get(ref) || 0;
    const newRetryCount = currentRetries + 1;

    this.logger.warn(`Error processing ref ${ref} (attempt ${newRetryCount}/${this.MAX_RETRIES}):`, error);

    if (newRetryCount >= this.MAX_RETRIES) {
      // Ban the ref after max retries
      this.bannedRefs.add(ref);
      this.refRetryCount.delete(ref);

      this.logger.error(`Ref ${ref} has been banned after ${this.MAX_RETRIES} failed attempts`);
      this.errorHandler.handleError(error, 'SwarmHistory.processMessageRef');
    } else {
      this.refRetryCount.set(ref, newRetryCount);

      // Calculate exponential backoff delay
      const delay = this.RETRY_DELAY * Math.pow(2, currentRetries);
      this.logger.debug(`Retrying ref ${ref} after ${delay}ms delay`);

      await sleep(delay);
      await this.processMessageRefWithRetry(ref);
    }
  }

  public cleanup() {
    this.processedRefs.clear();
    this.refRetryCount.clear();
    this.bannedRefs.clear();
  }
}
