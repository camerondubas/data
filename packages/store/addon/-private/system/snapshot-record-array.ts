/**
  @module @ember-data/store
*/

import { deprecate } from '@ember/debug';

import { DEPRECATE_SNAPSHOT_MODEL_CLASS_ACCESS } from '@ember-data/private-build-infra/deprecations';

import type { ModelSchema } from '../ts-interfaces/ds-model';
import { FindOptions } from '../ts-interfaces/store';
import type { Dict } from '../ts-interfaces/utils';
import type RecordArray from './record-arrays/record-array';
import type Snapshot from './snapshot';
/**
  SnapshotRecordArray is not directly instantiable.
  Instances are provided to consuming application's
  adapters for certain requests.

  @class SnapshotRecordArray
  @public
*/
export default class SnapshotRecordArray {
  declare _snapshots: Snapshot[] | null;
  declare _recordArray: RecordArray;
  declare _type: ModelSchema | null;

  declare length: number;
  declare meta: Dict<unknown> | null;
  declare adapterOptions?: Dict<unknown>;
  declare include?: string;

  /**
    SnapshotRecordArray is not directly instantiable.
    Instances are provided to consuming application's
    adapters and serializers for certain requests.

    @method constructor
    @private
    @constructor
    @param {RecordArray} recordArray
    @param {Object} meta
    @param options
   */
  constructor(recordArray: RecordArray, meta: Dict<unknown> | null, options: FindOptions = {}) {
    /**
      An array of snapshots
      @private
      @property _snapshots
      @type {Array}
    */
    this._snapshots = null;

    /**
      An array of records
      @private
      @property _recordArray
      @type {Array}
    */
    this._recordArray = recordArray;

    /**
      Number of records in the array

      Example

      ```app/adapters/post.js
      import JSONAPIAdapter from '@ember-data/adapter/json-api';

      export default class PostAdapter extends JSONAPIAdapter {
        shouldReloadAll(store, snapshotRecordArray) {
          return !snapshotRecordArray.length;
        }
      });
      ```

      @property length
      @public
      @type {Number}
    */
    this.length = recordArray.get('length');

    /**
      Meta objects for the record array.

      Example

      ```app/adapters/post.js
      import JSONAPIAdapter from '@ember-data/adapter/json-api';

      export default class PostAdapter extends JSONAPIAdapter {
        shouldReloadAll(store, snapshotRecordArray) {
          let lastRequestTime = snapshotRecordArray.meta.lastRequestTime;
          let twentyMinutes = 20 * 60 * 1000;
          return Date.now() > lastRequestTime + twentyMinutes;
        }
      });
      ```

      @property meta
      @public
      @type {Object}
    */
    this.meta = meta;

    /**
      A hash of adapter options passed into the store method for this request.

      Example

      ```app/adapters/post.js
      import MyCustomAdapter from './custom-adapter';

      export default class PostAdapter extends MyCustomAdapter {
        findAll(store, type, sinceToken, snapshotRecordArray) {
          if (snapshotRecordArray.adapterOptions.subscribe) {
            // ...
          }
          // ...
        }
      }
      ```

      @property adapterOptions
      @public
      @type {Object}
    */
    this.adapterOptions = options.adapterOptions;

    /**
      The relationships to include for this request.

      Example

      ```app/adapters/application.js
      import Adapter from '@ember-data/adapter';

      export default class ApplicationAdapter extends Adapter {
        findAll(store, type, snapshotRecordArray) {
          let url = `/${type.modelName}?include=${encodeURIComponent(snapshotRecordArray.include)}`;

          return fetch(url).then((response) => response.json())
        }
      }
      ```

      @property include
      @public
      @type {String|Array}
    */
    this.include = options.include;
  }

  /**
    The type of the underlying records for the snapshots in the array, as a Model
    @property type
    @deprecated
    @public
    @type {Model}
  */

  /**
    The modelName of the underlying records for the snapshots in the array, as a Model
    @property modelName
    @public
    @type {Model}
  */
  get modelName() {
    return this._recordArray.modelName;
  }

  /**
    Get snapshots of the underlying record array

    Example

    ```app/adapters/post.js
    import JSONAPIAdapter from '@ember-data/adapter/json-api';

    export default class PostAdapter extends JSONAPIAdapter {
      shouldReloadAll(store, snapshotArray) {
        let snapshots = snapshotArray.snapshots();

        return snapshots.any(function(ticketSnapshot) {
          let timeDiff = moment().diff(ticketSnapshot.attr('lastAccessedAt'), 'minutes');
          if (timeDiff > 20) {
            return true;
          } else {
            return false;
          }
        });
      }
    }
    ```

    @method snapshots
    @public
    @return {Array} Array of snapshots
  */
  snapshots() {
    if (this._snapshots !== null) {
      return this._snapshots;
    }

    this._snapshots = this._recordArray._takeSnapshot();

    return this._snapshots;
  }
}

if (DEPRECATE_SNAPSHOT_MODEL_CLASS_ACCESS) {
  Object.defineProperty(SnapshotRecordArray.prototype, 'type', {
    get() {
      deprecate(
        `Using SnapshotRecordArray.type to access the ModelClass for a record is deprecated. Use store.modelFor(<modelName>) instead.`,
        false,
        {
          id: 'ember-data:deprecate-snapshot-model-class-access',
          until: '5.0',
          for: 'ember-data',
          since: { available: '4.5.0', enabled: '4.5.0' },
        }
      );
      return this._recordArray.get('type');
    },
  });
}
