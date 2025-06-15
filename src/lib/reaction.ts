import { ReactionStateRef } from '../interfaces/message';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { validateReactionState } from '../utils/validation';

import { EVENTS } from './constants';
import { SwarmChatUtils } from './utils';

export class SwarmReaction {
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private processedRefs: Set<string> = new Set();
  private refRetryCount: Map<string, number> = new Map();
  private bannedRefs: Set<string> = new Set();
  private readonly MAX_RETRIES = 3;

  constructor(private utils: SwarmChatUtils, private emitter: EventEmitter) {}

  public async initializeReactions(reactionStateRefs: ReactionStateRef[] | null) {
    if (!reactionStateRefs || reactionStateRefs.length === 0) {
      this.logger.debug('No reaction state refs to initialize');
      return;
    }

    const latestRef = this.findLatestRef(reactionStateRefs);
    if (!latestRef) {
      this.logger.warn('No valid latest reference found');
      return;
    }

    this.logger.debug('Initializing reactions with latest ref:', latestRef.reference);
    await this.processReactionRef(latestRef.reference);
  }

  public async fetchPreviousReactions(reactionStateRefs: ReactionStateRef[] | null) {
    if (!reactionStateRefs || reactionStateRefs.length === 0) {
      this.logger.debug('No reaction state refs to fetch');
      return;
    }

    const sortedRefs = [...reactionStateRefs].sort((a, b) => a.timestamp - b.timestamp);

    for (const ref of sortedRefs) {
      if (!this.processedRefs.has(ref.reference) && !this.bannedRefs.has(ref.reference)) {
        this.logger.debug('Fetching previous reaction ref:', ref.reference);
        await this.processReactionRef(ref.reference);
      }
    }
  }

  private findLatestRef(refs: ReactionStateRef[]): ReactionStateRef | null {
    if (refs.length === 0) return null;

    return refs.reduce((latest, current) => (current.timestamp > latest.timestamp ? current : latest));
  }

  private async processReactionRef(ref: string): Promise<boolean> {
    if (this.processedRefs.has(ref) || this.bannedRefs.has(ref)) {
      return false;
    }

    try {
      const reactionState = await this.utils.downloadObjectFromBee(ref);

      const isValid = validateReactionState(reactionState);
      if (!isValid) {
        throw new Error(`Invalid reaction state for ref: ${ref}`);
      }

      this.processedRefs.add(ref);
      this.refRetryCount.delete(ref);
      this.emitter.emit(EVENTS.MESSAGE_REACTION_STATE_RECEIVED, { reactionState, ref });
      this.logger.debug('Successfully processed reaction ref:', ref);

      return true;
    } catch (error) {
      return this.handleRefError(ref, error);
    }
  }

  private handleRefError(ref: string, error: any): boolean {
    const currentRetries = this.refRetryCount.get(ref) || 0;
    const newRetryCount = currentRetries + 1;

    this.logger.warn(`Error processing ref ${ref} (attempt ${newRetryCount}/${this.MAX_RETRIES}):`, error);

    if (newRetryCount >= this.MAX_RETRIES) {
      this.bannedRefs.add(ref);
      this.refRetryCount.delete(ref);
      this.logger.error(`Ref ${ref} has been banned after ${this.MAX_RETRIES} failed attempts`);

      return false;
    } else {
      this.refRetryCount.set(ref, newRetryCount);
      this.errorHandler.handleError(error, 'SwarmReaction.processReactionRef');
      return false;
    }
  }

  public cleanupReactionState() {
    this.processedRefs.clear();
    this.refRetryCount.clear();
    this.bannedRefs.clear();
  }
}
