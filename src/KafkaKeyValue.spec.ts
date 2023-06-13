import KafkaKeyValue, { streamResponseBody, compressGzipPayload, decompressGzipResponse } from './KafkaKeyValue';
import updateEvents from './update-events';
import { EventEmitter } from 'events';
import { fail } from 'assert';
import { LabelValues } from 'prom-client';

const promClientMock = {
  Counter: class Counter {
    inc: any
    dec: any
    labels: any
    reset: any
    remove: any

    constructor(options) {

      this.inc = jest.fn();
      this.dec = jest.fn();
      this.labels = jest.fn().mockReturnValue(this);
      this.reset = jest.fn();
      this.remove = jest.fn();
    }
  },
  Gauge: class Gauge {
    inc: any
    dec: any
    set: any
    labels: any
    reset: any
    setToCurrentTime: any
    startTimer: any
    remove: any

    constructor(options) {

      this.inc = jest.fn();
      this.dec = jest.fn();
      this.set = jest.fn();
      this.labels = jest.fn().mockReturnValue(this);
      this.reset = jest.fn();
      this.setToCurrentTime = jest.fn();
      this.startTimer = jest.fn().mockReturnValue(() => jest.fn());
      this.remove = jest.fn();
    }
  },

  Histogram: class Histogram {
    observe: any
    startTimer: any
    labels: any
    reset: any
    remove: any

    constructor(options) {

      this.observe = jest.fn();
      this.startTimer = jest.fn().mockReturnValue(() => jest.fn());
      this.labels = jest.fn().mockReturnValue(this);
      this.reset = jest.fn();
      this.remove = jest.fn();
    }

    zero(labels: LabelValues<string>): void {
      throw new Error('Not implemented in mock');
    }
  },
};

describe('KafkaKeyValue', function () {

  describe('Sending put requests reliably to pixy', function () {

    it('needs to retry for a while before failing', async function () {

      const failedResponse = {
        status: 503,
        json: () => {}
      };

      const successResponse = {
        status: 200,
        json: async () => ({ offset: 3 })
      };

      const fetchMock = jest.fn();
      fetchMock.mockResolvedValueOnce(failedResponse);
      fetchMock.mockResolvedValueOnce(successResponse);

      const metrics = KafkaKeyValue.createMetrics(promClientMock.Counter, promClientMock.Gauge, promClientMock.Histogram);
      const kkv = new KafkaKeyValue({
        cacheHost: 'http://cache-kkv',
        metrics,
        pixyHost: 'http://pixy',
        topicName: 'testtopic01',
        fetchImpl: fetchMock,
      });

      const offset = await kkv.put('key1', 'value1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(offset).toEqual(3);
    });

    it('rejects after a number of times', async function () {

      const failedResponse = {
        status: 503,
        json: () => {}
      };

      const fetchMock = jest.fn();
      fetchMock.mockResolvedValue(failedResponse);

      const metrics = KafkaKeyValue.createMetrics(promClientMock.Counter, promClientMock.Gauge, promClientMock.Histogram);
      const kkv = new KafkaKeyValue({
        cacheHost: 'http://cache-kkv',
        metrics,
        pixyHost: 'http://pixy',
        topicName: 'testtopic01',
        fetchImpl: fetchMock,
      });

      try {
        await kkv.put('key1', 'value1', { intervalMs: 100, nRetries: 10 });
        fail('Put should have rejected eventually if we never get 200 back');
      } catch (err) {
        expect(fetchMock).toHaveBeenCalledTimes(11);
      }
    });
  });

  describe('gzipping payloads pre-put', function () {

    it('works', async function () {
      const buffer: Buffer = await compressGzipPayload(JSON.stringify({ foo: 'bar' }));
      const response = await decompressGzipResponse(console, buffer);
      expect(response).toEqual({ foo: 'bar' });
    });
  });

  describe('streaming values', function () {

    it('works on an empty topic', async function () {
      const bodyStream = new EventEmitter();


      const onValue = jest.fn();
      const streamCompleted = streamResponseBody(console, <any>bodyStream, onValue);

      bodyStream.emit('end');

      await streamCompleted;
      expect(onValue).toHaveBeenCalledTimes(0);
    });

    it('was tricky apparently', async function () {
      const bodyStream = new EventEmitter();


      const onValue = jest.fn();
      const streamCompleted = streamResponseBody(console, <any>bodyStream, onValue);

      bodyStream.emit('data', JSON.stringify({ foo: 'bar' }) + '\n');
      bodyStream.emit('data', JSON.stringify({ foo: 'bar2' }).substr(0, 4));
      bodyStream.emit('data', JSON.stringify({ foo: 'bar2' }).substr(4, 11) + '\n');
      bodyStream.emit('end');

      await streamCompleted;
      expect(onValue).toHaveBeenCalledTimes(2);
      expect(onValue).toBeCalledWith({ foo: 'bar' })
      expect(onValue).toBeCalledWith({ foo: 'bar2' })
    });

    it('updates last seen offset metric based on header value', async function () {
      const response = {
        body: new EventEmitter(),
        headers: new Map([
          ['x-kkv-last-seen-offsets', JSON.stringify([
            { topic: 'testtopic01', partition: 0, offset: 17 }
          ])]
        ])
      };

      const fetchMock = jest.fn().mockReturnValueOnce(response);

      const metrics = KafkaKeyValue.createMetrics(promClientMock.Counter, promClientMock.Gauge, promClientMock.Histogram);
      const kkv = new KafkaKeyValue({
        cacheHost: 'http://cache-kkv',
        metrics,
        pixyHost: 'http://pixy',
        topicName: 'testtopic01',
        fetchImpl: fetchMock
      });

      const streaming = kkv.streamValues(() => {});
      await Promise.resolve();
      response.body.emit('end');

      await streaming;

      expect(metrics.kafka_key_value_last_seen_offset.set).toHaveBeenCalledWith(
        {
          topic: 'testtopic01',
          partition: 0
        },
        17
      )
    });
  });

  describe('onupdate handlers', function () {

    it('requires us to document the behavior of a certain payload', async function () {

      const metrics = KafkaKeyValue.createMetrics(promClientMock.Counter, promClientMock.Gauge, promClientMock.Histogram);
      const kkv = new KafkaKeyValue({
        cacheHost: 'http://cache-kkv',
        metrics,
        pixyHost: 'http://pixy',
        topicName: 'testtopic01',
      });

      const onUpdateSpy = jest.fn();
      kkv.onUpdate(onUpdateSpy);
      kkv.get = jest.fn();
      (<jest.Mock>(kkv.get)).mockResolvedValueOnce({ foo: 'bar' })

      updateEvents.emit('update', {
        v: 1,
        topic: 'testtopic01',
        offsets: {
          '0': 28262
        },
        updates: {
          'bd3f6188-d865-443d-8646-03e8f1c643cb': {}
        }
      });

      // Promises needs to resolve before we get new value
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(onUpdateSpy).toHaveBeenCalledTimes(1);
      expect(onUpdateSpy).toHaveBeenCalledWith('bd3f6188-d865-443d-8646-03e8f1c643cb', { foo: 'bar' });

      expect(metrics.kafka_key_value_last_seen_offset.set).toHaveBeenCalledTimes(1);
      expect(metrics.kafka_key_value_last_seen_offset.labels).toHaveBeenCalledTimes(1);
      expect(metrics.kafka_key_value_last_seen_offset.labels).toHaveBeenCalledWith('cache-kkv', 'testtopic01', '0');
      expect(metrics.kafka_key_value_last_seen_offset.set).toHaveBeenCalledWith(28262);

      updateEvents.emit('update', {
        v: 1,
        topic: 'testtopic01',
        offsets: {
          '0': 28263
        },
        updates: {
          'bd3f6188-d865-443d-8646-03e8f1c643cb': {}
        }
      });

      // Promises needs to resolve before we get new value
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(onUpdateSpy).toHaveBeenCalledTimes(2);
    });

    it('only handles updates for the same key once if called within the debounce timeout period', async function () {
      const metrics = KafkaKeyValue.createMetrics(promClientMock.Counter, promClientMock.Gauge, promClientMock.Histogram);
      const kkv = new KafkaKeyValue({
        cacheHost: 'http://cache-kkv',
        metrics,
        pixyHost: 'http://pixy',
        topicName: 'testtopic01',
      });

      const onUpdateSpy = jest.fn();
      kkv.onUpdate(onUpdateSpy);
      kkv.get = jest.fn();
      (<jest.Mock>(kkv.get)).mockResolvedValue({ foo: 'bar' })

      // Three duplicates
      updateEvents.emit('update', {
        v: 1,
        topic: 'testtopic01',
        offsets: {
          '0': 28262
        },
        updates: {
          'bd3f6188-d865-443d-8646-03e8f1c643cb': {}
        }
      });
      updateEvents.emit('update', {
        v: 1,
        topic: 'testtopic01',
        offsets: {
          '0': 28262
        },
        updates: {
          'bd3f6188-d865-443d-8646-03e8f1c643cb': {}
        }
      });
      updateEvents.emit('update', {
        v: 1,
        topic: 'testtopic01',
        offsets: {
          '0': 28262
        },
        updates: {
          'bd3f6188-d865-443d-8646-03e8f1c643cb': {}
        }
      });

      // Three more duplicates with another key
      updateEvents.emit('update', {
        v: 1,
        topic: 'testtopic01',
        offsets: {
          '0': 28262
        },
        updates: {
          'aaaa6188-d865-443d-8646-03e8f1c643cb': {}
        }
      });
      updateEvents.emit('update', {
        v: 1,
        topic: 'testtopic01',
        offsets: {
          '0': 28262
        },
        updates: {
          'aaaa6188-d865-443d-8646-03e8f1c643cb': {}
        }
      });
      updateEvents.emit('update', {
        v: 1,
        topic: 'testtopic01',
        offsets: {
          '0': 28262
        },
        updates: {
          'aaaa6188-d865-443d-8646-03e8f1c643cb': {}
        }
      });

      // Wait a few milliseconds more than the debounce timeout
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(onUpdateSpy).toHaveBeenCalledTimes(2);
      expect(onUpdateSpy).toHaveBeenCalledWith('bd3f6188-d865-443d-8646-03e8f1c643cb', { foo: 'bar' })
      expect(onUpdateSpy).toHaveBeenCalledWith('aaaa6188-d865-443d-8646-03e8f1c643cb', { foo: 'bar' })

      updateEvents.emit('update', {
        v: 1,
        topic: 'testtopic01',
        offsets: {
          '0': 28265
        },
        updates: {
          'aaaa6188-d865-443d-8646-03e8f1c643cb': {}
        }
      });

      await Promise.resolve();

      expect(onUpdateSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('updatePartitionOffsetMetrics', function () {
    it('only updates metrics with higher offsets, so that debounced onupdate handlers does not reduce the offests', function () {
      const metrics = KafkaKeyValue.createMetrics(promClientMock.Counter, promClientMock.Gauge, promClientMock.Histogram);
      const kkv = new KafkaKeyValue({
        cacheHost: 'http://cache-kkv',
        metrics,
        pixyHost: 'http://pixy',
        topicName: 'testtopic01',
      });

      kkv.updatePartitionOffsetMetrics({
        ['p2']: 2,
        ['p1']: 1,
      });
      expect(metrics.kafka_key_value_last_seen_offset.set).toHaveBeenCalledTimes(2);
      expect(metrics.kafka_key_value_last_seen_offset.set).toHaveBeenCalledWith(1);
      expect(metrics.kafka_key_value_last_seen_offset.set).toHaveBeenCalledWith(2);
      expect(metrics.kafka_key_value_last_seen_offset.labels).toHaveBeenCalledTimes(2);
      expect(metrics.kafka_key_value_last_seen_offset.labels).toHaveBeenCalledWith('cache-kkv', 'testtopic01', 'p1');
      expect(metrics.kafka_key_value_last_seen_offset.labels).toHaveBeenCalledWith('cache-kkv', 'testtopic01', 'p2');

      kkv.updatePartitionOffsetMetrics({
        ['p2']: 1,
        ['p1']: 1,
      });
      expect(metrics.kafka_key_value_last_seen_offset.set).toHaveBeenCalledTimes(2);
      expect(metrics.kafka_key_value_last_seen_offset.labels).toHaveBeenCalledTimes(2);

      kkv.updatePartitionOffsetMetrics({
        ['p2']: 3,
      });
      expect(metrics.kafka_key_value_last_seen_offset.set).toHaveBeenCalledTimes(3);
      expect(metrics.kafka_key_value_last_seen_offset.set).toHaveBeenLastCalledWith(3);
      expect(metrics.kafka_key_value_last_seen_offset.labels).toHaveBeenCalledTimes(3);
      expect(metrics.kafka_key_value_last_seen_offset.labels).toHaveBeenLastCalledWith('cache-kkv', 'testtopic01', 'p2');

    });
  })
});