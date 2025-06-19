import { FeedIndex } from '@ethersphere/bee-js';
import { CommentsWithIndex, readCommentsInRange, readSingleComment, SingleComment } from '@solarpunkltd/comment-system';

import { isEmpty } from './validation';

export const DEFAULT_NUM_OF_COMMENTS = 9;
export const DEFAULT_BEE_API_URL = 'http://localhost:1633';

export const readLatestComment = async (
  identifier?: string,
  address?: string,
  beeApiUrl?: string,
): Promise<SingleComment | undefined> => {
  try {
    return await readSingleComment(undefined, {
      identifier,
      address,
      beeApiUrl,
    });
  } catch (err) {
    console.error(`Loading the latest comment of identifier ${identifier} error: ${err}`);
    return {} as SingleComment;
  }
};

export const loadLatestComments = async (
  identifier?: string,
  address?: string,
  beeApiUrl?: string,
  numOfComments?: number,
): Promise<CommentsWithIndex> => {
  const commentsToRead = (numOfComments || DEFAULT_NUM_OF_COMMENTS) - 1;
  try {
    const latestComment = await readLatestComment(identifier, address, beeApiUrl);
    if (
      isEmpty(latestComment) ||
      latestComment?.nextIndex === undefined ||
      new FeedIndex(latestComment.nextIndex).toBigInt() === 0n
    ) {
      return {} as CommentsWithIndex;
    }
    // if there is only one comment, return it
    if (new FeedIndex(latestComment.nextIndex).toBigInt() === 1n) {
      return {
        comments: [latestComment.comment],
        nextIndex: latestComment.nextIndex,
      } as CommentsWithIndex;
    }

    // the latest comment is already fetched
    const endIx = new FeedIndex(latestComment.nextIndex).toBigInt() - 2n;
    const startIx = endIx > commentsToRead ? endIx - BigInt(commentsToRead) + 1n : 0n;
    const comments = await readCommentsInRange(FeedIndex.fromBigInt(startIx), FeedIndex.fromBigInt(endIx), {
      identifier,
      beeApiUrl,
      address,
    });
    return {
      comments: [...comments, latestComment.comment],
      nextIndex: latestComment.nextIndex,
    } as CommentsWithIndex;
  } catch (err) {
    console.error(`Loading the last ${commentsToRead} comments of identifier ${identifier} error: ${err}`);
    return {} as CommentsWithIndex;
  }
};

export const loadNextComments = async (
  nextIx: number,
  identifier?: string,
  address?: string,
  beeApiUrl?: string,
  numOfComments?: number,
): Promise<CommentsWithIndex> => {
  const commentsToRead = (numOfComments || DEFAULT_NUM_OF_COMMENTS) - 1;
  try {
    const latestComment = await readLatestComment(identifier, address, beeApiUrl);
    if (
      isEmpty(latestComment) ||
      latestComment?.nextIndex === undefined ||
      new FeedIndex(latestComment.nextIndex).toBigInt() === 0n ||
      new FeedIndex(latestComment.nextIndex).toBigInt() <= BigInt(nextIx)
    ) {
      return {} as CommentsWithIndex;
    }
    // if there is only one comment, return it
    if (new FeedIndex(latestComment.nextIndex).toBigInt() - BigInt(nextIx) === 1n) {
      return {
        comments: [latestComment.comment],
        nextIndex: latestComment.nextIndex,
      } as CommentsWithIndex;
    }

    const startIx = nextIx === undefined ? 0n : BigInt(nextIx);
    let endIx = startIx + BigInt(commentsToRead) - 1n;
    // read until the end of the list or until commentsToRead is read
    if (endIx >= new FeedIndex(latestComment.nextIndex).toBigInt()) {
      endIx = new FeedIndex(latestComment.nextIndex).toBigInt() - 2n;
    }

    const comments = await readCommentsInRange(FeedIndex.fromBigInt(startIx), FeedIndex.fromBigInt(endIx), {
      identifier,
      beeApiUrl,
      address,
    });
    // the latest comment is already fetched
    return {
      comments: [...comments, latestComment.comment],
      nextIndex: FeedIndex.fromBigInt(endIx + 1n).toString(),
    } as CommentsWithIndex;
  } catch (err) {
    console.error(`Loading the next ${commentsToRead} comments of identifier ${identifier} error: ${err}`);
    return {} as CommentsWithIndex;
  }
};
