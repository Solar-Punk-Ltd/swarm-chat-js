import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { validateReactionState } from '../utils/validation';

import { EVENTS } from './constants';
import { SwarmChatUtils } from './utils';

export class SwarmReaction {
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private currReactionStateRef: string | null = null;
  private latestPendingRef: string | null = null;
  private isProcessing: boolean = false;
  private refRetryCount: Map<string, number> = new Map();
  private bannedRefs: Set<string> = new Set();

  private readonly MAX_RETRIES = 3;

  constructor(private utils: SwarmChatUtils, private emitter: EventEmitter) {}

  public async loadReactionState(ref: string) {
    if (ref === this.currReactionStateRef) {
      return;
    }

    if (this.bannedRefs.has(ref)) {
      return;
    }

    this.latestPendingRef = ref;

    if (this.isProcessing) {
      return;
    }

    await this.processLatestRef();
  }

  private async processLatestRef() {
    while (this.latestPendingRef && this.latestPendingRef !== this.currReactionStateRef) {
      const refToProcess = this.latestPendingRef;

      if (this.bannedRefs.has(refToProcess)) {
        this.latestPendingRef = null;
        continue;
      }

      this.isProcessing = true;
      this.latestPendingRef = null;

      try {
        const reactionState = await this.utils.downloadObjectFromBee(refToProcess);

        const isValid = validateReactionState(reactionState);
        if (!isValid) {
          throw new Error(`Invalid reaction state for ref: ${refToProcess}`);
        }

        this.refRetryCount.delete(refToProcess);
        this.currReactionStateRef = refToProcess;

        this.emitter.emit(EVENTS.MESSAGE_REACTION_STATE_RECEIVED, { reactionState });
      } catch (error) {
        this.handleRefError(refToProcess, error);
      } finally {
        this.isProcessing = false;
      }
    }
  }

  private handleRefError(ref: string, error: any) {
    const currentRetries = this.refRetryCount.get(ref) || 0;
    const newRetryCount = currentRetries + 1;

    this.logger.warn(`Error processing ref ${ref} (attempt ${newRetryCount}/${this.MAX_RETRIES}):`, error);

    if (newRetryCount >= this.MAX_RETRIES) {
      this.bannedRefs.add(ref);
      this.refRetryCount.delete(ref);
      this.logger.error(`Ref ${ref} has been banned after ${this.MAX_RETRIES} failed attempts`);
    } else {
      this.refRetryCount.set(ref, newRetryCount);

      if (!this.latestPendingRef) {
        this.latestPendingRef = ref;
      }
    }

    this.errorHandler.handleError(error, 'SwarmReaction.loadReactionState');
  }

  public cleanupReactionState() {
    this.isProcessing = false;
    this.latestPendingRef = null;
    this.refRetryCount.clear();
    this.bannedRefs.clear();
  }
}
