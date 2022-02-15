import { RunCommandEvent, RunCommandEventEnum } from '../../src';
import { Observable } from 'rxjs';

const equals = (arr1: Array<boolean | number | string>, arr2: Array<boolean | number | string>) => JSON.stringify(arr1) === JSON.stringify(arr2);
const areEquivalent = (arr1: Array<boolean | number | string>, arr2: Array<boolean | number | string>) => equals(arr1.sort(), arr2.sort());

type ReceivedEvent = {type: RunCommandEventEnum, workspace?: string};

export const expectObservable = async (
  runCommand$: Observable<RunCommandEvent>,
  expectedTimeframe: string,
  expectedWorkspaces: { [idx: number]: string[] },
  predicate?: (received: ReceivedEvent[]) => void,
) => {
  return new Promise<void>((resolve, reject) => {
    const receivedEvents: ReceivedEvent[] = [];
    runCommand$.subscribe((evt) => {
      console.debug(evt);
      switch (evt.type) {
        case RunCommandEventEnum.TARGETS_RESOLVED:
          receivedEvents.push({ type: evt.type });
          break;
        case RunCommandEventEnum.NODE_STARTED:
        case RunCommandEventEnum.NODE_ERRORED:
        case RunCommandEventEnum.NODE_PROCESSED:
        case RunCommandEventEnum.NODE_SKIPPED:
        case RunCommandEventEnum.ERROR_INVALIDATING_CACHE:
        case RunCommandEventEnum.CACHE_INVALIDATED:
          console.log({ type: evt.type, workspace: evt.workspace?.name });
          receivedEvents.push({ type: evt.type, workspace: evt.workspace?.name });
          break;
        default:
          console.error('Unexpected event type', evt);
          reject();
          break;
      }
    }, (err) => {
      console.error(err);
    }, () => {
      console.debug(receivedEvents);
      const expectedFrames = expectedTimeframe.split('-');
      const expectedEventCount = expectedFrames.map((frame) => [...frame]).reduce((acc, val) => acc += val.length, 0);
      if (expectedEventCount !== receivedEvents.length) {
        reject(`Events count mismatch:
        expected: ${expectedEventCount}
        received: ${receivedEvents.length}`)
      }
      let offset = 0;
      let timeframeError = false;
      let receivedFrame = '';
      for (const expectedFrame of expectedFrames) {
        console.debug({ offset });
        const expectedEventTypes: number[] = [...expectedFrame].map((t) => Number(t));
        const receivedEventTypes = receivedEvents.slice(offset, offset + expectedEventTypes.length).map((e) => e.type);
        console.debug({ expectedEventTypes, receivedEventTypes });
        const isComparable = areEquivalent(receivedEventTypes, expectedEventTypes);
        if (!isComparable) {
          timeframeError = true;
        }
        console.log(receivedEventTypes.join(''));
        receivedFrame += (offset ? '-' : '') + receivedEventTypes.join('')
        offset += expectedEventTypes.length;
      }
      if (timeframeError) {
        reject(`Timeframe error:
          expected: ${expectedTimeframe}
          received: ${receivedFrame}`)
      }

      for (const type of [1, 2, 3, 4]) {
        if (expectedWorkspaces[type]) {
          const receivedWorkspaces = receivedEvents
            .filter((e) => e.type === type)
            .map((e) => e.workspace!);
          if (!areEquivalent(receivedWorkspaces, expectedWorkspaces[type])) {
            reject(`Received values mismatch (${type}):
          received: ${receivedWorkspaces}
          expected: ${expectedWorkspaces[type]}`);
          }
        }
      }

      if (predicate) {
        predicate(receivedEvents);
      }
      resolve();
    });
  });
}
