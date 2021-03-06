/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @emails oncall+relay
 * @format
 */

// flowlint ambiguous-object-type:error

'use strict';

const {
  fetchQuery,
  getPromiseForActiveRequest,
  getObservableForActiveRequest,
  isRequestActive,
} = require('../fetchQueryInternal');
const {createOperationDescriptor} = require('relay-runtime');
const {
  createMockEnvironment,
  generateAndCompile,
} = require('relay-test-utils-internal');

import type {Observer} from 'relay-runtime';

let response;
let gqlQuery;
let query;
let environment;

beforeEach(() => {
  environment = createMockEnvironment();
  gqlQuery = generateAndCompile(
    `query TestQuery($id: ID!) {
          node(id: $id) {
            id
          }
        }
      `,
  ).TestQuery;
  query = createOperationDescriptor(gqlQuery, {id: '4'});
  response = {
    data: {
      node: {
        __typename: 'User',
        id: '4',
      },
    },
    extensions: {is_final: true},
  };
});

describe('fetchQuery', () => {
  it('fetches a query', () => {
    let calledObserver = false;
    const observer = {
      complete: () => {
        calledObserver = true;
      },
    };
    const subscription = fetchQuery(environment, query).subscribe(observer);
    environment.mock.nextValue(gqlQuery, response);
    environment.mock.complete(gqlQuery);
    subscription.unsubscribe();
    expect(calledObserver).toEqual(true);
  });

  it('provides data snapshot on `next(...)`', () => {
    let calledNext = false;
    const values = [];
    const observer = {
      next: value => {
        calledNext = true;
        values.push(value);
      },
    };
    fetchQuery(environment, query).subscribe(observer);
    environment.mock.nextValue(gqlQuery, response);
    expect(calledNext).toEqual(true);
    expect(values).toEqual([response]);
    environment.mock.complete(gqlQuery);
  });

  it('unsubscribes when the request is disposed', () => {
    let calledNext = false;
    let calledUnsubscribe = false;
    const observer = {
      next: () => {
        calledNext = true;
      },
      unsubscribe: () => {
        calledUnsubscribe = true;
      },
    };
    const subscription = fetchQuery(environment, query).subscribe(observer);
    environment.mock.nextValue(gqlQuery, response);
    subscription.unsubscribe();
    expect(calledNext).toEqual(true);
    expect(calledUnsubscribe).toEqual(true);
  });

  it('handles error correctly', () => {
    let calledError = false;
    let errorMessage = null;
    const observer = {
      error: error => {
        calledError = true;
        errorMessage = error.message;
      },
    };
    const subscription = fetchQuery(environment, query).subscribe(observer);
    environment.mock.reject(gqlQuery, new Error('Oops'));
    expect(calledError).toEqual(true);
    expect(errorMessage).toEqual('Oops');
    subscription.unsubscribe();
  });

  it('can dispose same request multiple times without error', () => {
    let calledObserver = false;
    const observer = {
      complete: () => {
        calledObserver = true;
      },
    };
    const subscription = fetchQuery(environment, query).subscribe(observer);
    expect(
      environment.mock.isLoading(gqlQuery, query.request.variables),
    ).toEqual(true);

    environment.mock.nextValue(gqlQuery, response);
    environment.mock.complete(gqlQuery);
    subscription.unsubscribe();
    subscription.unsubscribe();
    expect(calledObserver).toEqual(true);
    expect(
      environment.mock.isLoading(gqlQuery, query.request.variables),
    ).toEqual(false);
  });

  it('unsubscribes from request until the last observer is disposed', () => {
    let unsubscribedObserver1 = false;
    let unsubscribedObserver2 = false;
    const observer1 = {
      unsubscribe: () => {
        unsubscribedObserver1 = true;
      },
    };
    const observer2 = {
      unsubscribe: () => {
        unsubscribedObserver2 = true;
      },
    };
    expect(environment.execute).toHaveBeenCalledTimes(0);

    const subscription1 = fetchQuery(environment, query).subscribe(observer1);
    const subscription2 = fetchQuery(environment, query).subscribe(observer2);

    expect(environment.execute).toHaveBeenCalledTimes(1);

    environment.mock.nextValue(gqlQuery, response);
    expect(unsubscribedObserver1).toEqual(false);
    expect(unsubscribedObserver2).toEqual(false);
    expect(
      environment.mock.isLoading(gqlQuery, query.request.variables),
    ).toEqual(true);

    // Disposing same request twice has no effect
    subscription1.unsubscribe();
    subscription1.unsubscribe();

    expect(unsubscribedObserver1).toEqual(true);
    expect(unsubscribedObserver2).toEqual(false);
    expect(
      environment.mock.isLoading(gqlQuery, query.request.variables),
    ).toEqual(true);

    subscription2.unsubscribe();

    expect(unsubscribedObserver1).toEqual(true);
    expect(unsubscribedObserver2).toEqual(true);
    expect(
      environment.mock.isLoading(gqlQuery, query.request.variables),
    ).toEqual(false);

    expect(environment.execute).toHaveBeenCalledTimes(1);
  });

  describe('.toPromise()', () => {
    it('fetches request and does not retain query data', async () => {
      const promise = fetchQuery(environment, query).toPromise();
      expect(
        environment.mock.isLoading(gqlQuery, query.request.variables),
      ).toEqual(true);
      environment.mock.nextValue(gqlQuery, response);
      const result = await promise;
      expect(result).toEqual(response);
      expect(
        environment.mock.isLoading(gqlQuery, query.request.variables),
      ).toEqual(false);
    });

    it('rejects when error occurs', async () => {
      const promise = fetchQuery(environment, query).toPromise();
      expect(
        environment.mock.isLoading(gqlQuery, query.request.variables),
      ).toEqual(true);
      environment.mock.reject(gqlQuery, new Error('Oops'));
      try {
        await promise;
      } catch (error) {
        expect(error.message).toEqual('Oops');
      }
      expect(
        environment.mock.isLoading(gqlQuery, query.request.variables),
      ).toEqual(false);
    });
  });

  describe('when making a request that is already in flight', () => {
    it('does not de-dupe requests if using different environments', () => {
      const environment2 = createMockEnvironment();
      let calledObserver1 = false;
      let calledObserver2 = false;
      const observer1 = {
        complete: () => {
          calledObserver1 = true;
        },
      };
      const observer2 = {
        complete: () => {
          calledObserver2 = true;
        },
      };
      const subscription1 = fetchQuery(environment, query).subscribe(observer1);
      const subscription2 = fetchQuery(environment2, query).subscribe(
        observer2,
      );
      expect(
        environment.mock.isLoading(gqlQuery, query.request.variables),
      ).toEqual(true);
      expect(
        environment2.mock.isLoading(gqlQuery, query.request.variables),
      ).toEqual(true);

      environment.mock.nextValue(gqlQuery, response);
      environment2.mock.nextValue(gqlQuery, response);
      environment.mock.complete(gqlQuery);
      environment2.mock.complete(gqlQuery);
      expect(calledObserver1).toEqual(true);
      expect(calledObserver2).toEqual(true);
      subscription1.unsubscribe();
      subscription2.unsubscribe();
      expect(
        environment.mock.isLoading(gqlQuery, query.request.variables),
      ).toEqual(false);
      expect(
        environment2.mock.isLoading(gqlQuery, query.request.variables),
      ).toEqual(false);
      expect(environment.execute).toHaveBeenCalledTimes(1);
      expect(environment2.execute).toHaveBeenCalledTimes(1);
    });

    it('de-dupes request and notifies all observers', () => {
      let calledObserver1 = false;
      let calledObserver2 = false;
      const observer1 = {
        complete: () => {
          calledObserver1 = true;
        },
      };
      const observer2 = {
        complete: () => {
          calledObserver2 = true;
        },
      };
      const subscription1 = fetchQuery(environment, query).subscribe(observer1);
      const subscription2 = fetchQuery(environment, query).subscribe(observer2);
      expect(
        environment.mock.isLoading(gqlQuery, query.request.variables),
      ).toEqual(true);

      environment.mock.nextValue(gqlQuery, response);
      environment.mock.complete(gqlQuery);
      subscription1.unsubscribe();
      subscription2.unsubscribe();
      expect(
        environment.mock.isLoading(gqlQuery, query.request.variables),
      ).toEqual(false);
      expect(environment.execute).toHaveBeenCalledTimes(1);
      expect(calledObserver1).toEqual(true);
      expect(calledObserver2).toEqual(true);
    });

    it('de-dupes request and notifies observers of events that were missed', () => {
      let observer1Payload = null;
      let calledObserver1Complete = false;
      let observer2Payload = null;
      let calledObserver2Complete = false;
      const observer1 = {
        next: data => {
          observer1Payload = data;
        },
        complete: () => {
          calledObserver1Complete = true;
        },
      };
      const observer2 = {
        next: data => {
          observer2Payload = data;
        },
        complete: () => {
          calledObserver2Complete = true;
        },
      };
      const subscription1 = fetchQuery(environment, query).subscribe(observer1);
      // Emit a payload before second observer subscribes
      environment.mock.nextValue(gqlQuery, response);

      const subscription2 = fetchQuery(environment, query).subscribe(observer2);

      expect(
        environment.mock.isLoading(gqlQuery, query.request.variables),
      ).toEqual(true);
      environment.mock.complete(gqlQuery);
      subscription1.unsubscribe();
      subscription2.unsubscribe();
      expect(environment.execute).toHaveBeenCalledTimes(1);

      // Assert both observers got the payload
      expect(observer1Payload).toEqual(response);
      expect(observer2Payload).toEqual(response);
      expect(observer1Payload).toEqual(observer2Payload);

      expect(calledObserver1Complete).toEqual(true);
      expect(calledObserver2Complete).toEqual(true);
    });
  });
});

describe('isRequestActive', () => {
  it('returns false if request is not in flight', () => {
    const isActive = isRequestActive(environment, query.request);
    expect(isActive).toEqual(false);
  });

  it('returns false if request is not active', () => {
    const observer = {
      complete: jest.fn(),
      error: jest.fn(),
      next: jest.fn(),
      unsubscribe: jest.fn(),
    };
    fetchQuery(environment, query).subscribe(observer);
    environment.mock.nextValue(gqlQuery, response);

    const isActive = isRequestActive(environment, query.request);
    expect(isActive).toEqual(false);
  });

  it('returns true when request is active', () => {
    fetchQuery(environment, query).subscribe({});

    const isActive = isRequestActive(environment, query.request);
    expect(isActive).toEqual(true);
  });
});

describe('getPromiseForActiveRequest', () => {
  it('returns null if request is not in flight', () => {
    const promise = getPromiseForActiveRequest(environment, query.request);
    expect(promise).toEqual(null);
  });

  it('returns null if request is not active', () => {
    const observer = {
      complete: jest.fn(),
      error: jest.fn(),
      next: jest.fn(),
      unsubscribe: jest.fn(),
    };
    fetchQuery(environment, query).subscribe(observer);
    environment.mock.nextValue(gqlQuery, response);

    const promise = getPromiseForActiveRequest(environment, query.request);
    expect(promise).toEqual(null);
  });

  it('returns null after request has completed', () => {
    const observer = {
      complete: jest.fn(),
      error: jest.fn(),
      next: jest.fn(),
      unsubscribe: jest.fn(),
    };
    fetchQuery(environment, query).subscribe(observer);
    environment.mock.resolve(gqlQuery, response);

    const promise = getPromiseForActiveRequest(environment, query.request);
    expect(promise).toEqual(null);
  });

  it('returns null after request has errored', () => {
    const observer = {
      complete: jest.fn(),
      error: jest.fn(),
      next: jest.fn(),
      unsubscribe: jest.fn(),
    };
    fetchQuery(environment, query).subscribe(observer);
    environment.mock.reject(gqlQuery, new Error('Oops'));

    const promise = getPromiseForActiveRequest(environment, query.request);
    expect(promise).toEqual(null);
  });

  it('returns null after request has unsubscribed (canceled)', () => {
    const observer = {
      complete: jest.fn(),
      error: jest.fn(),
      next: jest.fn(),
      unsubscribe: jest.fn(),
    };
    const subscription = fetchQuery(environment, query).subscribe(observer);
    subscription.unsubscribe();

    const promise = getPromiseForActiveRequest(environment, query.request);
    expect(promise).toEqual(null);
  });

  describe('when request is active', () => {
    let observer;
    let subscription;
    beforeEach(() => {
      observer = {
        complete: jest.fn(),
        error: jest.fn(),
        next: jest.fn(),
        unsubscribe: jest.fn(),
      };
      subscription = fetchQuery(environment, query).subscribe(observer);
    });
    it('returns a promise that rejects when error occurs', () => {
      expect.assertions(5);
      const promise = getPromiseForActiveRequest(environment, query.request);
      expect(promise).not.toEqual(null);
      if (!promise) {
        return;
      }

      // Assert that promise hasn't resolved
      const spy = jest.fn();
      promise.then(spy).catch(spy);
      jest.runAllTimers();
      expect(spy).toHaveBeenCalledTimes(0);

      // Make observable call `error`
      environment.mock.reject(gqlQuery, new Error('Oops'));

      // Assert promise rejects after calling `error`
      return promise.catch(error => {
        expect(observer.next).toHaveBeenCalledTimes(0);
        expect(observer.complete).toHaveBeenCalledTimes(0);
        expect(error.message).toEqual('Oops');
      });
    });

    it('returns a promise that resolves when the request is unsubcribed (canceled)', () => {
      expect.assertions(4);
      const promise = getPromiseForActiveRequest(environment, query.request);
      expect(promise).not.toEqual(null);
      if (!promise) {
        return;
      }

      // Assert that promise hasn't resolved
      const spy = jest.fn();
      promise.then(spy).catch(spy);
      jest.runAllTimers();
      expect(spy).toHaveBeenCalledTimes(0);

      // Cancel the request
      subscription.unsubscribe();

      // Assert promise resolves after the request is cancelled
      return promise.then(() => {
        expect(observer.next).toHaveBeenCalledTimes(0);
        expect(observer.unsubscribe).toHaveBeenCalledTimes(1);
      });
    });

    it('calling getPromiseForActiveRequest does not prevent the request from being unsubscribed (canceled)', () => {
      expect.assertions(6);
      const promise = getPromiseForActiveRequest(environment, query.request);
      expect(promise).not.toEqual(null);
      if (!promise) {
        return;
      }

      // Assert that promise hasn't resolved
      const spy = jest.fn();
      promise.then(spy).catch(spy);
      jest.runAllTimers();
      expect(spy).toHaveBeenCalledTimes(0);

      // Cancel the request
      subscription.unsubscribe();

      // Assert that unsubscribe is called and that the
      // request is actually cancelled at the network level
      expect(observer.unsubscribe).toBeCalledTimes(1);
      expect(
        environment.mock.isLoading(query, query.request.variables),
      ).toEqual(false);

      // Assert promise resolves after the request is cancelled
      return promise.then(() => {
        expect(observer.next).toHaveBeenCalledTimes(0);
        expect(observer.unsubscribe).toHaveBeenCalledTimes(1);
      });
    });

    describe("when `next` hasn't been called", () => {
      it('returns a promise that resolves when the next call to `next` occurs', () => {
        expect.assertions(4);
        const promise = getPromiseForActiveRequest(environment, query.request);
        expect(promise).not.toEqual(null);
        if (!promise) {
          return;
        }

        // Assert that promise hasn't resolved
        const spy = jest.fn();
        promise.then(spy).catch(spy);
        jest.runAllTimers();
        expect(spy).toHaveBeenCalledTimes(0);

        // Make observable call `next`
        environment.mock.nextValue(gqlQuery, response);

        // Assert promise resolves after calling `next`
        return promise.then(() => {
          expect(observer.next).toHaveBeenCalledTimes(1);
          expect(observer.complete).toHaveBeenCalledTimes(0);
        });
      });

      it('returns a promise that resolves when the request completes', () => {
        expect.assertions(4);
        const promise = getPromiseForActiveRequest(environment, query.request);
        expect(promise).not.toEqual(null);
        if (!promise) {
          return;
        }

        // Assert that promise hasn't resolved
        const spy = jest.fn();
        promise.then(spy).catch(spy);
        jest.runAllTimers();
        expect(spy).toHaveBeenCalledTimes(0);

        // Make observable call `complete`
        environment.mock.complete(gqlQuery);

        // Assert promise resolves after calling `complete`
        return promise.then(() => {
          expect(observer.next).toHaveBeenCalledTimes(0);
          expect(observer.complete).toHaveBeenCalledTimes(1);
        });
      });
    });

    describe('when next has already been called and request is still active', () => {
      beforeEach(() => {
        response = {
          ...response,
          extensions: {is_final: false},
        };
        environment.mock.nextValue(gqlQuery, response);
        expect(observer.next).toHaveBeenCalledTimes(1);
      });

      it('returns a promise that resolves when the next call to `next` occurs', () => {
        expect.assertions(5);
        const promise = getPromiseForActiveRequest(environment, query.request);
        expect(promise).not.toEqual(null);
        if (!promise) {
          return;
        }

        // Assert that promise hasn't resolved even if first call to
        // `next` has already occurred
        const spy = jest.fn();
        promise.then(spy).catch(spy);
        jest.runAllTimers();
        expect(spy).toHaveBeenCalledTimes(0);

        // Make observable call `next`
        environment.mock.nextValue(gqlQuery, response);

        // Assert promise resolves after calling `next`
        return promise.then(() => {
          expect(observer.next).toHaveBeenCalledTimes(2);
          expect(observer.complete).toHaveBeenCalledTimes(0);
        });
      });

      it('returns a promise that resolves when the next call to `next` occurs when next has been called more than once', () => {
        expect.assertions(6);

        // Call next a second time
        environment.mock.nextValue(gqlQuery, response);
        expect(observer.next).toHaveBeenCalledTimes(2);

        const promise = getPromiseForActiveRequest(environment, query.request);
        expect(promise).not.toEqual(null);
        if (!promise) {
          return;
        }

        // Assert that promise hasn't resolved even if first call to
        // `next` has already occurred
        const spy = jest.fn();
        promise.then(spy).catch(spy);
        jest.runAllTimers();
        expect(spy).toHaveBeenCalledTimes(0);

        // Make observable call `next`
        environment.mock.nextValue(gqlQuery, response);

        // Assert promise resolves after calling `next`
        return promise.then(() => {
          expect(observer.next).toHaveBeenCalledTimes(3);
          expect(observer.complete).toHaveBeenCalledTimes(0);
        });
      });

      it('returns a promise that resolves when the request completes', () => {
        expect.assertions(5);
        const promise = getPromiseForActiveRequest(environment, query.request);
        expect(promise).not.toEqual(null);
        if (!promise) {
          return;
        }

        // Assert that promise hasn't resolved even if first call to
        // `next` has already occurred
        const spy = jest.fn();
        promise.then(spy).catch(spy);
        jest.runAllTimers();
        expect(spy).toHaveBeenCalledTimes(0);

        // Make observable call `complete`
        environment.mock.complete(gqlQuery);

        // Assert promise resolves after calling `complete`
        return promise.then(() => {
          expect(observer.next).toHaveBeenCalledTimes(1);
          expect(observer.complete).toHaveBeenCalledTimes(1);
        });
      });
    });
  });
});

describe('getObservableForActiveRequest', () => {
  let observer: Observer<void>;
  let events;
  beforeEach(() => {
    events = [];
    observer = {
      complete: jest.fn(() => events.push('complete')),
      error: jest.fn(error => events.push('error', error)),
      next: jest.fn(() => events.push('next')),
    };
  });

  it('returns null if request is not in flight', () => {
    const observable = getObservableForActiveRequest(
      environment,
      query.request,
    );
    expect(observable).toEqual(null);
  });

  it('returns null if request is not active', () => {
    fetchQuery(environment, query).subscribe({});
    environment.mock.nextValue(gqlQuery, response);

    const observable = getObservableForActiveRequest(
      environment,
      query.request,
    );
    expect(observable).toEqual(null);
  });

  it('returns null if the request has already errored', () => {
    fetchQuery(environment, query).subscribe({error: jest.fn()});
    const error = new Error('Oops');
    environment.mock.reject(gqlQuery, error);
    const observable = getObservableForActiveRequest(
      environment,
      query.request,
    );
    expect(observable).toBe(null);
  });

  it('errors asynchronously if the request errors', () => {
    fetchQuery(environment, query).subscribe({error: jest.fn()});
    const observable = getObservableForActiveRequest(
      environment,
      query.request,
    );
    expect(observable).not.toEqual(null);
    if (!observable) {
      return;
    }

    observable.subscribe(observer);
    expect(events).toEqual([]);

    const error = new Error('Oops');
    environment.mock.reject(gqlQuery, error);
    expect(events).toEqual(['error', error]);
  });

  it('returns null if the request has already completed', () => {
    fetchQuery(environment, query).subscribe({});
    environment.mock.complete(gqlQuery);
    const observable = getObservableForActiveRequest(
      environment,
      query.request,
    );
    expect(observable).toBe(null);
  });

  it('completes asynchronously if the request completes', () => {
    fetchQuery(environment, query).subscribe({});
    const observable = getObservableForActiveRequest(
      environment,
      query.request,
    );
    expect(observable).not.toEqual(null);
    if (!observable) {
      return;
    }

    observable.subscribe(observer);
    expect(events).toEqual([]);

    environment.mock.complete(gqlQuery);
    expect(events).toEqual(['complete']);
  });

  it('calls next asynchronously with subsequent non-final payloads', () => {
    fetchQuery(environment, query).subscribe({});
    const observable = getObservableForActiveRequest(
      environment,
      query.request,
    );
    expect(observable).not.toEqual(null);
    if (!observable) {
      return;
    }

    response = {
      ...response,
      extensions: {is_final: false},
    };

    observable.subscribe(observer);
    expect(events).toEqual([]);

    environment.mock.nextValue(gqlQuery, response);
    expect(events).toEqual(['next']);
  });

  it('calls complete asynchronously with subsequent final payload', () => {
    fetchQuery(environment, query).subscribe({});
    const observable = getObservableForActiveRequest(
      environment,
      query.request,
    );
    expect(observable).not.toEqual(null);
    if (!observable) {
      return;
    }

    observable.subscribe(observer);
    expect(events).toEqual([]);

    environment.mock.nextValue(gqlQuery, response);
    expect(events).toEqual(['complete']);
  });
});
