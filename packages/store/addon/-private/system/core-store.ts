/**
  @module @ember-data/store
 */
import { getOwner, setOwner } from '@ember/application';
import { assert, deprecate, inspect, warn } from '@ember/debug';
import { _backburner as emberBackburner } from '@ember/runloop';
import type { Backburner } from '@ember/runloop/-private/backburner';
import Service from '@ember/service';
import { registerWaiter, unregisterWaiter } from '@ember/test';
import { DEBUG } from '@glimmer/env';
import Ember from 'ember';

import { importSync } from '@embroider/macros';
import { all, reject, resolve } from 'rsvp';

import type DSModelClass from '@ember-data/model';
import type BelongsToReference from '@ember-data/model/-private/references/belongs-to';
import type HasManyReference from '@ember-data/model/-private/references/has-many';
import { HAS_MODEL_PACKAGE, HAS_RECORD_DATA_PACKAGE } from '@ember-data/private-build-infra';
import {
  DEPRECATE_HAS_RECORD,
  DEPRECATE_JSON_API_FALLBACK,
  DEPRECATE_RECORD_WAS_INVALID,
  DEPRECATE_STORE_FIND,
} from '@ember-data/private-build-infra/deprecations';
import type { ManyRelationship, RecordData as RecordDataClass } from '@ember-data/record-data/-private';
import type { RelationshipState } from '@ember-data/record-data/-private/graph/-state';

import { IdentifierCache } from '../identifiers/cache';
import { InstanceCache } from '../instance-cache';
import type { DSModel } from '../ts-interfaces/ds-model';
import type {
  CollectionResourceDocument,
  EmptyResourceDocument,
  ExistingResourceObject,
  JsonApiDocument,
  ResourceIdentifierObject,
  SingleResourceDocument,
} from '../ts-interfaces/ember-data-json-api';
import type {
  RecordIdentifier,
  StableExistingRecordIdentifier,
  StableRecordIdentifier,
} from '../ts-interfaces/identifier';
import { MinimumAdapterInterface } from '../ts-interfaces/minimum-adapter-interface';
import type { MinimumSerializerInterface } from '../ts-interfaces/minimum-serializer-interface';
import type { RecordData } from '../ts-interfaces/record-data';
import type { JsonApiRelationship } from '../ts-interfaces/record-data-json-api';
import type { RecordDataRecordWrapper } from '../ts-interfaces/record-data-record-wrapper';
import type { RecordInstance } from '../ts-interfaces/record-instance';
import type { SchemaDefinitionService } from '../ts-interfaces/schema-definition-service';
import type { FindOptions } from '../ts-interfaces/store';
import type { Dict } from '../ts-interfaces/utils';
import constructResource from '../utils/construct-resource';
import promiseRecord from '../utils/promise-record';
import edBackburner from './backburner';
import coerceId, { ensureStringId } from './coerce-id';
import FetchManager, { SaveOp } from './fetch-manager';
import type InternalModel from './model/internal-model';
import type ShimModelClass from './model/shim-model-class';
import { getShimClass } from './model/shim-model-class';
import normalizeModelName from './normalize-model-name';
import { PromiseArray, promiseArray, PromiseObject, promiseObject } from './promise-proxies';
import RecordArrayManager from './record-array-manager';
import { AdapterPopulatedRecordArray, RecordArray } from './record-arrays';
import recordDataFor, { setRecordDataFor } from './record-data-for';
import NotificationManager from './record-notification-manager';
import { RecordReference } from './references';
import type RequestCache from './request-cache';
import { DSModelSchemaDefinitionService, getModelFactory } from './schema-definition-service';
import { _findAll, _findBelongsTo, _findHasMany, _query, _queryRecord } from './store/finders';
import {
  internalModelFactoryFor,
  peekRecordIdentifier,
  recordIdentifierFor,
  setRecordIdentifier,
} from './store/internal-model-factory';
import RecordDataStoreWrapper from './store/record-data-store-wrapper';
import WeakCache from './weak-cache';

type RecordDataConstruct = typeof RecordDataClass;
let _RecordData: RecordDataConstruct | undefined;

const { ENV } = Ember;
type AsyncTrackingToken = Readonly<{ label: string; trace: Error | string }>;

const RECORD_REFERENCES = new WeakCache<StableRecordIdentifier, RecordReference>(DEBUG ? 'reference' : '');
const StoreMap = new WeakCache<RecordInstance, CoreStore>(DEBUG ? 'store' : '');

export function storeFor(record: RecordInstance): CoreStore | undefined {
  const store = StoreMap.get(record);

  assert(
    `A record in a disconnected state cannot utilize the store. This typically means the record has been destroyed, most commonly by unloading it.`,
    store
  );
  return store;
}

function freeze<T>(obj: T): T {
  if (typeof Object.freeze === 'function') {
    return Object.freeze(obj);
  }

  return obj;
}

export interface CreateRecordProperties {
  id?: string | null;
  [key: string]: unknown;
}

/**
  The store contains all of the data for records loaded from the server.
  It is also responsible for creating instances of `Model` that wrap
  the individual data for a record, so that they can be bound to in your
  Handlebars templates.

  Define your application's store like this:

  ```app/services/store.js
  import Store from '@ember-data/store';

  export default class MyStore extends Store {}
  ```

  Most Ember.js applications will only have a single `Store` that is
  automatically created by their `Ember.Application`.

  You can retrieve models from the store in several ways. To retrieve a record
  for a specific id, use `Store`'s `findRecord()` method:

  ```javascript
  store.findRecord('person', 123).then(function (person) {
  });
  ```

  By default, the store will talk to your backend using a standard
  REST mechanism. You can customize how the store talks to your
  backend by specifying a custom adapter:

  ```app/adapters/application.js
  import Adapter from '@ember-data/adapter';

  export default class ApplicationAdapter extends Adapter {
  }
  ```

  You can learn more about writing a custom adapter by reading the `Adapter`
  documentation.

  ### Store createRecord() vs. push() vs. pushPayload()

  The store provides multiple ways to create new record objects. They have
  some subtle differences in their use which are detailed below:

  [createRecord](../methods/createRecord?anchor=createRecord) is used for creating new
  records on the client side. This will return a new record in the
  `created.uncommitted` state. In order to persist this record to the
  backend, you will need to call `record.save()`.

  [push](../methods/push?anchor=push) is used to notify Ember Data's store of new or
  updated records that exist in the backend. This will return a record
  in the `loaded.saved` state. The primary use-case for `store#push` is
  to notify Ember Data about record updates (full or partial) that happen
  outside of the normal adapter methods (for example
  [SSE](http://dev.w3.org/html5/eventsource/) or [Web
  Sockets](http://www.w3.org/TR/2009/WD-websockets-20091222/)).

  [pushPayload](../methods/pushPayload?anchor=pushPayload) is a convenience wrapper for
  `store#push` that will deserialize payloads if the
  Serializer implements a `pushPayload` method.

  Note: When creating a new record using any of the above methods
  Ember Data will update `RecordArray`s such as those returned by
  `store#peekAll()` or `store#findAll()`. This means any
  data bindings or computed properties that depend on the RecordArray
  will automatically be synced to include the new or updated record
  values.

  @main @ember-data/store
  @class Store
  @public
  @extends Ember.Service
*/

class CoreStore extends Service {
  /**
   * Ember Data uses several specialized micro-queues for organizing
    and coalescing similar async work.

    These queues are currently controlled by a flush scheduled into
    ember-data's custom backburner instance.
   *
   * EmberData specific backburner instance
   * @property _backburner
   * @private
   */
  declare _backburner: Backburner;
  declare recordArrayManager: RecordArrayManager;

  declare _notificationManager: NotificationManager;
  declare identifierCache: IdentifierCache;
  declare _adapterCache: Dict<MinimumAdapterInterface & { store: CoreStore }>;
  declare _serializerCache: Dict<MinimumSerializerInterface & { store: CoreStore }>;
  declare _storeWrapper: RecordDataStoreWrapper;
  declare _fetchManager: FetchManager;
  declare _schemaDefinitionService: SchemaDefinitionService;
  declare _instanceCache: InstanceCache;

  declare _modelFactoryCache;
  declare _relationshipsDefCache;
  declare _attributesDefCache;

  // DEBUG-only properties
  declare _trackedAsyncRequests: AsyncTrackingToken[];
  declare generateStackTracesForTrackedRequests: boolean;
  declare _trackAsyncRequestStart: (str: string) => void;
  declare _trackAsyncRequestEnd: (token: AsyncTrackingToken) => void;
  declare __asyncWaiter: () => boolean;

  /**
    @method init
    @private
  */
  constructor() {
    super(...arguments);
    this._adapterCache = Object.create(null);
    this._serializerCache = Object.create(null);
    this._storeWrapper = new RecordDataStoreWrapper(this);
    this._backburner = edBackburner;
    this.recordArrayManager = new RecordArrayManager({ store: this });
    this._instanceCache = new InstanceCache(this);

    this._modelFactoryCache = Object.create(null);
    this._relationshipsDefCache = Object.create(null);
    this._attributesDefCache = Object.create(null);

    RECORD_REFERENCES._generator = (identifier) => {
      return new RecordReference(this, identifier);
    };

    this._fetchManager = new FetchManager(this);
    this._notificationManager = new NotificationManager(this);
    this.__recordDataFor = this.__recordDataFor.bind(this);

    /**
     * Provides access to the IdentifierCache instance
     * for this store.
     *
     * The IdentifierCache can be used to generate or
     * retrieve a stable unique identifier for any resource.
     *
     * @property {IdentifierCache} identifierCache
     * @public
     */
    this.identifierCache = new IdentifierCache();

    if (DEBUG) {
      if (this.generateStackTracesForTrackedRequests === undefined) {
        this.generateStackTracesForTrackedRequests = false;
      }

      this._trackedAsyncRequests = [];
      this._trackAsyncRequestStart = (label) => {
        let trace: string | Error =
          'set `store.generateStackTracesForTrackedRequests = true;` to get a detailed trace for where this request originated';

        if (this.generateStackTracesForTrackedRequests) {
          try {
            throw new Error(`EmberData TrackedRequest: ${label}`);
          } catch (e) {
            trace = e as Error;
          }
        }

        let token = freeze({
          label,
          trace,
        });

        this._trackedAsyncRequests.push(token);
        return token;
      };
      this._trackAsyncRequestEnd = (token) => {
        let index = this._trackedAsyncRequests.indexOf(token);

        if (index === -1) {
          throw new Error(
            `Attempted to end tracking for the following request but it was not being tracked:\n${token}`
          );
        }

        this._trackedAsyncRequests.splice(index, 1);
      };

      this.__asyncWaiter = () => {
        let tracked = this._trackedAsyncRequests;
        return tracked.length === 0;
      };

      registerWaiter(this.__asyncWaiter);
    }
  }

  getRequestStateService(): RequestCache {
    return this._fetchManager.requestCache;
  }

  // TODO move this to InstanceCache
  _instantiateRecord(
    recordData: RecordData,
    identifier: StableRecordIdentifier,
    properties?: { [key: string]: unknown }
  ) {
    // assert here
    if (properties !== undefined) {
      assert(
        `You passed '${properties}' as properties for record creation instead of an object.`,
        typeof properties === 'object' && properties !== null
      );

      const { type } = identifier;

      // convert relationship Records to RecordDatas before passing to RecordData
      let defs = this.getSchemaDefinitionService().relationshipsDefinitionFor({ type });

      if (defs !== null) {
        let keys = Object.keys(properties);
        let relationshipValue;

        for (let i = 0; i < keys.length; i++) {
          let prop = keys[i];
          let def = defs[prop];

          if (def !== undefined) {
            if (def.kind === 'hasMany') {
              if (DEBUG) {
                assertRecordsPassedToHasMany(properties[prop]);
              }
              relationshipValue = extractRecordDatasFromRecords(properties[prop]);
            } else {
              relationshipValue = extractRecordDataFromRecord(properties[prop]);
            }

            properties[prop] = relationshipValue;
          }
        }
      }
    }

    // TODO guard against initRecordOptions no being there
    let createOptions = recordData._initRecordCreateOptions(properties);
    //TODO Igor pass a wrapper instead of RD
    let record = this.instantiateRecord(identifier, createOptions, this.__recordDataFor, this._notificationManager);
    setRecordIdentifier(record, identifier);
    setRecordDataFor(record, recordData);
    StoreMap.set(record, this);
    return record;
  }

  instantiateRecord(
    identifier: StableRecordIdentifier,
    createRecordArgs: { [key: string]: unknown },
    recordDataFor: (identifier: StableRecordIdentifier) => RecordDataRecordWrapper,
    notificationManager: NotificationManager
  ): DSModel | RecordInstance {
    if (HAS_MODEL_PACKAGE) {
      let modelName = identifier.type;
      let store = this;

      let internalModel = this._internalModelForResource(identifier);
      let createOptions: any = {
        _internalModel: internalModel,
        // TODO deprecate allowing unknown args setting
        _createProps: createRecordArgs,
        // TODO @deprecate consider deprecating accessing record properties during init which the below is necessary for
        _secretInit: (record: RecordInstance): void => {
          setRecordIdentifier(record, identifier);
          StoreMap.set(record, store);
          setRecordDataFor(record, internalModel._recordData);
        },
        container: null, // necessary hack for setOwner?
      };

      // ensure that `getOwner(this)` works inside a model instance
      setOwner(createOptions, getOwner(this));
      delete createOptions.container;
      return getModelFactory(this, this._modelFactoryCache, modelName).create(createOptions);
    }
    assert(`You must implement the store's instantiateRecord hook for your custom model class.`);
  }

  // TODO move this to InstanceCache
  _teardownRecord(record: DSModel | RecordInstance) {
    StoreMap.delete(record);
    // TODO remove identifier:record cache link
    this.teardownRecord(record);
  }
  teardownRecord(record: DSModel | RecordInstance): void {
    if (HAS_MODEL_PACKAGE) {
      assert(
        `expected to receive an instance of DSModel. If using a custom model make sure you implement teardownRecord`,
        'destroy' in record
      );
      (record as DSModel).destroy();
    } else {
      assert(`You must implement the store's teardownRecord hook for your custom models`);
    }
  }

  getSchemaDefinitionService(): SchemaDefinitionService {
    if (HAS_MODEL_PACKAGE && !this._schemaDefinitionService) {
      this._schemaDefinitionService = new DSModelSchemaDefinitionService(this);
    }
    assert(
      `You must registerSchemaDefinitionService with the store to use custom model classes`,
      this._schemaDefinitionService
    );
    return this._schemaDefinitionService;
  }

  registerSchemaDefinitionService(schema: SchemaDefinitionService) {
    this._schemaDefinitionService = schema;
  }

  /**
    Returns the schema for a particular `modelName`.

    When used with Model from @ember-data/model the return is the model class,
    but this is not guaranteed.

    The class of a model might be useful if you want to get a list of all the
    relationship names of the model, see
    [`relationshipNames`](/ember-data/release/classes/Model?anchor=relationshipNames)
    for example.

    @method modelFor
    @public
    @param {String} modelName
    @return {subclass of Model | ShimModelClass}
    */
  modelFor(modelName: string): ShimModelClass | DSModelClass {
    if (DEBUG) {
      assertDestroyedStoreOnly(this, 'modelFor');
    }
    assert(`You need to pass a model name to the store's modelFor method`, modelName);
    assert(
      `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${modelName}`,
      typeof modelName === 'string'
    );
    if (HAS_MODEL_PACKAGE) {
      let normalizedModelName = normalizeModelName(modelName);
      let maybeFactory = getModelFactory(this, this._modelFactoryCache, normalizedModelName);

      // for factorFor factory/class split
      let klass = maybeFactory && maybeFactory.class ? maybeFactory.class : maybeFactory;
      if (!klass || !klass.isModel) {
        assert(
          `No model was found for '${modelName}' and no schema handles the type`,
          this.getSchemaDefinitionService().doesTypeExist(modelName)
        );

        return getShimClass(this, modelName);
      } else {
        // TODO @deprecate ever returning the klass, always return the shim
        return klass;
      }
    }

    return getShimClass(this, modelName);
  }

  // .....................
  // . CREATE NEW RECORD .
  // .....................

  /**
    Create a new record in the current store. The properties passed
    to this method are set on the newly created record.

    To create a new instance of a `Post`:

    ```js
    store.createRecord('post', {
      title: 'Ember is awesome!'
    });
    ```

    To create a new instance of a `Post` that has a relationship with a `User` record:

    ```js
    let user = this.store.peekRecord('user', 1);
    store.createRecord('post', {
      title: 'Ember is awesome!',
      user: user
    });
    ```

    @method createRecord
    @public
    @param {String} modelName
    @param {Object} inputProperties a hash of properties to set on the
      newly created record.
    @return {Model} record
  */
  createRecord(modelName: string, inputProperties: CreateRecordProperties): RecordInstance {
    if (DEBUG) {
      assertDestroyingStore(this, 'createRecord');
    }
    assert(`You need to pass a model name to the store's createRecord method`, modelName);
    assert(
      `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${modelName}`,
      typeof modelName === 'string'
    );

    // This is wrapped in a `run.join` so that in test environments users do not need to manually wrap
    //   calls to `createRecord`. The run loop usage here is because we batch the joining and updating
    //   of record-arrays via ember's run loop, not our own.
    //
    //   to remove this, we would need to move to a new `async` API.
    return emberBackburner.join(() => {
      return this._backburner.join(() => {
        let normalizedModelName = normalizeModelName(modelName);
        let properties = { ...inputProperties };

        // If the passed properties do not include a primary key,
        // give the adapter an opportunity to generate one. Typically,
        // client-side ID generators will use something like uuid.js
        // to avoid conflicts.

        if (properties.id === null || properties.id === undefined) {
          let adapter = this.adapterFor(modelName);

          if (adapter && adapter.generateIdForRecord) {
            properties.id = adapter.generateIdForRecord(this, modelName, properties);
          } else {
            properties.id = null;
          }
        }

        // Coerce ID to a string
        properties.id = coerceId(properties.id);

        const factory = internalModelFactoryFor(this);
        const internalModel = factory.build({ type: normalizedModelName, id: properties.id });
        const { identifier } = internalModel;

        this._instanceCache.getRecordData(identifier).clientDidCreate();
        this.recordArrayManager.recordDidChange(identifier);

        return this._instanceCache.getRecord(identifier, properties);
      });
    });
  }

  // .................
  // . DELETE RECORD .
  // .................

  /**
    For symmetry, a record can be deleted via the store.

    Example

    ```javascript
    let post = store.createRecord('post', {
      title: 'Ember is awesome!'
    });

    store.deleteRecord(post);
    ```

    @method deleteRecord
    @public
    @param {Model} record
  */
  deleteRecord(record: RecordInstance): void {
    if (DEBUG) {
      assertDestroyingStore(this, 'deleteRecord');
    }
    this._backburner.join(() => {
      let identifier = peekRecordIdentifier(record);
      if (identifier) {
        let internalModel = internalModelFactoryFor(this).peek(identifier);
        if (internalModel) {
          internalModel.deleteRecord();
        }
      }
    });
  }

  /**
    For symmetry, a record can be unloaded via the store.
    This will cause the record to be destroyed and freed up for garbage collection.

    Example

    ```javascript
    store.findRecord('post', 1).then(function(post) {
      store.unloadRecord(post);
    });
    ```

    @method unloadRecord
    @public
    @param {Model} record
  */
  unloadRecord(record: RecordInstance): void {
    if (DEBUG) {
      assertDestroyingStore(this, 'unloadRecord');
    }
    let identifier = peekRecordIdentifier(record);
    if (identifier) {
      let internalModel = internalModelFactoryFor(this).peek(identifier);
      if (internalModel) {
        internalModel.unloadRecord();
      }
    }
  }

  // ................
  // . FIND RECORDS .
  // ................

  /**
    @method find
    @param {String} modelName
    @param {String|Integer} id
    @param {Object} options
    @return {Promise} promise
    @deprecated
    @private
  */
  find(modelName: string, id: string | number, options?): PromiseObject<RecordInstance> {
    if (DEBUG) {
      assertDestroyingStore(this, 'find');
    }
    // The default `model` hook in Route calls `find(modelName, id)`,
    // that's why we have to keep this method around even though `findRecord` is
    // the public way to get a record by modelName and id.
    assert(
      `Using store.find(type) has been removed. Use store.findAll(modelName) to retrieve all records for a given type.`,
      arguments.length !== 1
    );
    assert(
      `Calling store.find(modelName, id, { preload: preload }) is no longer supported. Use store.findRecord(modelName, id, { preload: preload }) instead.`,
      !options
    );
    assert(`You need to pass the model name and id to the store's find method`, arguments.length === 2);
    assert(
      `You cannot pass '${id}' as id to the store's find method`,
      typeof id === 'string' || typeof id === 'number'
    );
    assert(
      `Calling store.find() with a query object is no longer supported. Use store.query() instead.`,
      typeof id !== 'object'
    );
    assert(
      `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${modelName}`,
      typeof modelName === 'string'
    );

    if (DEPRECATE_STORE_FIND) {
      deprecate(
        `Using store.find is deprecated, use store.findRecord instead. Likely this means you are relying on the implicit store fetching behavior of routes unknowingly.`,
        false,
        {
          id: 'ember-data:deprecate-store-find',
          since: { available: '4.5', enabled: '4.5' },
          for: 'ember-data',
          until: '5.0',
        }
      );
      return this.findRecord(modelName, id);
    }
    assert(`store.find has been removed. Use store.findRecord instead.`);
  }

  /**
    This method returns a record for a given identifier or type and id combination.

    The `findRecord` method will always resolve its promise with the same
    object for a given identifier or type and `id`.

    The `findRecord` method will always return a **promise** that will be
    resolved with the record.

    **Example 1**

    ```app/routes/post.js
    import Route from '@ember/routing/route';

    export default class PostRoute extends Route {
      model({ post_id }) {
        return this.store.findRecord('post', post_id);
      }
    }
    ```

    **Example 2**

    `findRecord` can be called with a single identifier argument instead of the combination
    of `type` (modelName) and `id` as separate arguments. You may recognize this combo as
    the typical pairing from [JSON:API](https://jsonapi.org/format/#document-resource-object-identification)

    ```app/routes/post.js
    import Route from '@ember/routing/route';

    export default class PostRoute extends Route {
      model({ post_id: id }) {
        return this.store.findRecord({ type: 'post', id });
      }
    }
    ```

    **Example 3**

    If you have previously received an lid via an Identifier for this record, and the record
    has already been assigned an id, you can find the record again using just the lid.

    ```app/routes/post.js
    store.findRecord({ lid });
    ```

    If the record is not yet available, the store will ask the adapter's `findRecord`
    method to retrieve and supply the necessary data. If the record is already present
    in the store, it depends on the reload behavior _when_ the returned promise
    resolves.

    ### Preloading

    You can optionally `preload` specific attributes and relationships that you know of
    by passing them via the passed `options`.

    For example, if your Ember route looks like `/posts/1/comments/2` and your API route
    for the comment also looks like `/posts/1/comments/2` if you want to fetch the comment
    without also fetching the post you can pass in the post to the `findRecord` call:

    ```app/routes/post-comments.js
    import Route from '@ember/routing/route';

    export default class PostRoute extends Route {
      model({ post_id, comment_id: id }) {
        return this.store.findRecord({ type: 'comment', id, { preload: { post: post_id }} });
      }
    }
    ```

    In your adapter you can then access this id without triggering a network request via the
    snapshot:

    ```app/adapters/application.js
    import EmberObject from '@ember/object';

    export default class Adapter extends EmberObject {

      findRecord(store, schema, id, snapshot) {
        let type = schema.modelName;

        if (type === 'comment')
          let postId = snapshot.belongsTo('post', { id: true });

          return fetch(`./posts/${postId}/comments/${id}`)
            .then(response => response.json())
        }
      }
    }
    ```

    This could also be achieved by supplying the post id to the adapter via the adapterOptions
    property on the options hash.

    ```app/routes/post-comments.js
    import Route from '@ember/routing/route';

    export default class PostRoute extends Route {
      model({ post_id, comment_id: id }) {
        return this.store.findRecord({ type: 'comment', id, { adapterOptions: { post: post_id }} });
      }
    }
    ```

    ```app/adapters/application.js
    import EmberObject from '@ember/object';

    export default class Adapter extends EmberObject {

      findRecord(store, schema, id, snapshot) {
        let type = schema.modelName;

        if (type === 'comment')
          let postId = snapshot.adapterOptions.post;

          return fetch(`./posts/${postId}/comments/${id}`)
            .then(response => response.json())
        }
      }
    }
    ```

    If you have access to the post model you can also pass the model itself to preload:

    ```javascript
    let post = await store.findRecord('post', 1);
    let comment = await store.findRecord('comment', 2, { post: myPostModel });
    ```

    ### Reloading

    The reload behavior is configured either via the passed `options` hash or
    the result of the adapter's `shouldReloadRecord`.

    If `{ reload: true }` is passed or `adapter.shouldReloadRecord` evaluates
    to `true`, then the returned promise resolves once the adapter returns
    data, regardless if the requested record is already in the store:

    ```js
    store.push({
      data: {
        id: 1,
        type: 'post',
        revision: 1
      }
    });

    // adapter#findRecord resolves with
    // [
    //   {
    //     id: 1,
    //     type: 'post',
    //     revision: 2
    //   }
    // ]
    store.findRecord('post', 1, { reload: true }).then(function(post) {
      post.get('revision'); // 2
    });
    ```

    If no reload is indicated via the above mentioned ways, then the promise
    immediately resolves with the cached version in the store.

    ### Background Reloading

    Optionally, if `adapter.shouldBackgroundReloadRecord` evaluates to `true`,
    then a background reload is started, which updates the records' data, once
    it is available:

    ```js
    // app/adapters/post.js
    import ApplicationAdapter from "./application";

    export default class PostAdapter extends ApplicationAdapter {
      shouldReloadRecord(store, snapshot) {
        return false;
      },

      shouldBackgroundReloadRecord(store, snapshot) {
        return true;
      }
    });

    // ...

    store.push({
      data: {
        id: 1,
        type: 'post',
        revision: 1
      }
    });

    let blogPost = store.findRecord('post', 1).then(function(post) {
      post.get('revision'); // 1
    });

    // later, once adapter#findRecord resolved with
    // [
    //   {
    //     id: 1,
    //     type: 'post',
    //     revision: 2
    //   }
    // ]

    blogPost.get('revision'); // 2
    ```

    If you would like to force or prevent background reloading, you can set a
    boolean value for `backgroundReload` in the options object for
    `findRecord`.

    ```app/routes/post/edit.js
    import Route from '@ember/routing/route';

    export default class PostEditRoute extends Route {
      model(params) {
        return this.store.findRecord('post', params.post_id, { backgroundReload: false });
      }
    }
    ```

    If you pass an object on the `adapterOptions` property of the options
    argument it will be passed to your adapter via the snapshot

    ```app/routes/post/edit.js
    import Route from '@ember/routing/route';

    export default class PostEditRoute extends Route {
      model(params) {
        return this.store.findRecord('post', params.post_id, {
          adapterOptions: { subscribe: false }
        });
      }
    }
    ```

    ```app/adapters/post.js
    import MyCustomAdapter from './custom-adapter';

    export default class PostAdapter extends MyCustomAdapter {
      findRecord(store, type, id, snapshot) {
        if (snapshot.adapterOptions.subscribe) {
          // ...
        }
        // ...
      }
    }
    ```

    See [peekRecord](../methods/peekRecord?anchor=peekRecord) to get the cached version of a record.

    ### Retrieving Related Model Records

    If you use an adapter such as Ember's default
    [`JSONAPIAdapter`](/ember-data/release/classes/JSONAPIAdapter)
    that supports the [JSON API specification](http://jsonapi.org/) and if your server
    endpoint supports the use of an
    ['include' query parameter](http://jsonapi.org/format/#fetching-includes),
    you can use `findRecord()` or `findAll()` to automatically retrieve additional records related to
    the one you request by supplying an `include` parameter in the `options` object.

    For example, given a `post` model that has a `hasMany` relationship with a `comment`
    model, when we retrieve a specific post we can have the server also return that post's
    comments in the same request:

    ```app/routes/post.js
    import Route from '@ember/routing/route';

    export default class PostRoute extends Route {
      model(params) {
        return this.store.findRecord('post', params.post_id, { include: 'comments' });
      }
    }
    ```

    ```app/adapters/application.js
    import EmberObject from '@ember/object';

    export default class Adapter extends EmberObject {

      findRecord(store, schema, id, snapshot) {
        let type = schema.modelName;

        if (type === 'post')
          let includes = snapshot.adapterOptions.include;

          return fetch(`./posts/${postId}?include=${includes}`)
            .then(response => response.json())
        }
      }
    }
    ```

    In this case, the post's comments would then be available in your template as
    `model.comments`.

    Multiple relationships can be requested using an `include` parameter consisting of a
    comma-separated list (without white-space) while nested relationships can be specified
    using a dot-separated sequence of relationship names. So to request both the post's
    comments and the authors of those comments the request would look like this:

    ```app/routes/post.js
    import Route from '@ember/routing/route';

    export default class PostRoute extends Route {
      model(params) {
        return this.store.findRecord('post', params.post_id, { include: 'comments,comments.author' });
      }
    }
    ```

    ### Retrieving Specific Fields by Type

    If your server endpoint supports the use of a ['fields' query parameter](https://jsonapi.org/format/#fetching-sparse-fieldsets),
    you can use pass those fields through to your server.  At this point in time, this requires a few manual steps on your part.

    1. Implement `buildQuery` in your adapter.

    ```app/adapters/application.js
    buildQuery(snapshot) {
      let query = super.buildQuery(...arguments);

      let { fields } = snapshot.adapterOptions;

      if (fields) {
        query.fields = fields;
      }

      return query;
    }
    ```

    2. Then pass through the applicable fields to your `findRecord` request.

    Given a `post` model with attributes body, title, publishDate and meta, you can retrieve a filtered list of attributes.

    ```app/routes/post.js
    import Route from '@ember/routing/route';
    export default Route.extend({
      model(params) {
        return this.store.findRecord('post', params.post_id, { adapterOptions: { fields: { post: 'body,title' } });
      }
    });
    ```

    Moreover, you can filter attributes on related models as well. If a `post` has a `belongsTo` relationship to a user,
    just include the relationship key and attributes.

    ```app/routes/post.js
    import Route from '@ember/routing/route';
    export default Route.extend({
      model(params) {
        return this.store.findRecord('post', params.post_id, { adapterOptions: { fields: { post: 'body,title', user: 'name,email' } });
      }
    });
    ```

    @since 1.13.0
    @method findRecord
    @public
    @param {String|object} modelName - either a string representing the modelName or a ResourceIdentifier object containing both the type (a string) and the id (a string) for the record or an lid (a string) of an existing record
    @param {(String|Integer|Object)} id - optional object with options for the request only if the first param is a ResourceIdentifier, else the string id of the record to be retrieved
    @param {Object} [options] - if the first param is a string this will be the optional options for the request. See examples for available options.
    @return {Promise} promise
  */
  findRecord(resource: string, id: string | number, options?: FindOptions): PromiseObject<RecordInstance>;
  findRecord(resource: ResourceIdentifierObject, id?: FindOptions): PromiseObject<RecordInstance>;
  findRecord(
    resource: string | ResourceIdentifierObject,
    id?: string | number | FindOptions,
    options?: FindOptions
  ): PromiseObject<RecordInstance> {
    if (DEBUG) {
      assertDestroyingStore(this, 'findRecord');
    }

    assert(
      `You need to pass a modelName or resource identifier as the first argument to the store's findRecord method`,
      resource
    );
    if (isMaybeIdentifier(resource)) {
      options = id as FindOptions | undefined;
    } else {
      assert(
        `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${resource}`,
        typeof resource === 'string'
      );
      const type = normalizeModelName(resource);
      const normalizedId = ensureStringId(id as string | number);
      resource = constructResource(type, normalizedId);
    }

    const internalModel = internalModelFactoryFor(this).lookup(resource);
    const { identifier } = internalModel;
    let promise;
    options = options || {};

    // if not loaded start loading
    if (!internalModel.isLoaded) {
      promise = this._fetchDataIfNeededForIdentifier(identifier, options);

      // Refetch if the reload option is passed
    } else if (options.reload) {
      assertIdentifierHasId(identifier);
      promise = this._fetchManager.scheduleFetch(identifier, options);
    } else {
      let snapshot = this._instanceCache.createSnapshot(identifier, options);
      let adapter = this.adapterFor(identifier.type);

      // Refetch the record if the adapter thinks the record is stale
      if (
        typeof options.reload === 'undefined' &&
        adapter.shouldReloadRecord &&
        adapter.shouldReloadRecord(this, snapshot)
      ) {
        assertIdentifierHasId(identifier);
        promise = this._fetchManager.scheduleFetch(identifier, options);
      } else {
        // Trigger the background refetch if backgroundReload option is passed
        if (
          options.backgroundReload !== false &&
          (options.backgroundReload ||
            !adapter.shouldBackgroundReloadRecord ||
            adapter.shouldBackgroundReloadRecord(this, snapshot))
        ) {
          assertIdentifierHasId(identifier);
          this._fetchManager.scheduleFetch(identifier, options);
        }

        // Return the cached record
        promise = resolve(identifier);
      }
    }

    return promiseRecord(this, promise, `DS: Store#findRecord ${identifier}`);
  }

  _fetchDataIfNeededForIdentifier(
    identifier: StableRecordIdentifier,
    options: FindOptions = {}
  ): Promise<StableRecordIdentifier> {
    const cache = this._instanceCache;
    const internalModel = cache.getInternalModel(identifier);

    // pre-loading will change the isEmpty value
    // TODO stpre this state somewhere other than InternalModel
    const { isEmpty, isLoading } = internalModel;

    if (options.preload) {
      this._backburner.join(() => {
        internalModel.preloadData(options.preload);
      });
    }

    let promise;
    if (isEmpty) {
      assertIdentifierHasId(identifier);

      promise = this._fetchManager.scheduleFetch(identifier, options);
    } else if (isLoading) {
      promise = this._fetchManager.getPendingFetch(identifier, options);
      assert(`Expected to find a pending request for a record in the loading state, but found none`, promise);
    } else {
      promise = resolve(identifier);
    }

    return promise;
  }

  _scheduleFetchMany(
    identifiers: StableRecordIdentifier[],
    options: FindOptions = {}
  ): Promise<StableRecordIdentifier[]> {
    let fetches = new Array(identifiers.length);
    const manager = this._fetchManager;

    for (let i = 0; i < identifiers.length; i++) {
      let identifier = identifiers[i];
      assertIdentifierHasId(identifier);
      fetches[i] = manager.scheduleFetch(identifier, options);
    }

    return all(fetches);
  }

  /**
    Get the reference for the specified record.

    Example

    ```javascript
    let userRef = store.getReference('user', 1);

    // check if the user is loaded
    let isLoaded = userRef.value() !== null;

    // get the record of the reference (null if not yet available)
    let user = userRef.value();

    // get the identifier of the reference
    if (userRef.remoteType() === 'id') {
    let id = userRef.id();
    }

    // load user (via store.find)
    userRef.load().then(...)

    // or trigger a reload
    userRef.reload().then(...)

    // provide data for reference
    userRef.push({ id: 1, username: '@user' }).then(function(user) {
      userRef.value() === user;
    });
    ```

    @method getReference
    @public
    @param {String|object} resource - modelName (string) or Identifier (object)
    @param {String|Integer} id
    @since 2.5.0
    @return {RecordReference}
  */
  getReference(resource: string | ResourceIdentifierObject, id: string | number): RecordReference {
    if (DEBUG) {
      assertDestroyingStore(this, 'getReference');
    }

    let resourceIdentifier;
    if (arguments.length === 1 && isMaybeIdentifier(resource)) {
      resourceIdentifier = resource;
    } else {
      const type = normalizeModelName(resource as string);
      const normalizedId = ensureStringId(id);
      resourceIdentifier = constructResource(type, normalizedId);
    }

    assert(
      'getReference expected to receive either a resource identifier or type and id as arguments',
      isMaybeIdentifier(resourceIdentifier)
    );

    let identifier: StableRecordIdentifier = this.identifierCache.getOrCreateRecordIdentifier(resourceIdentifier);
    return RECORD_REFERENCES.lookup(identifier);
  }

  /**
    Get a record by a given type and ID without triggering a fetch.

    This method will synchronously return the record if it is available in the store,
    otherwise it will return `null`. A record is available if it has been fetched earlier, or
    pushed manually into the store.

    See [findRecord](../methods/findRecord?anchor=findRecord) if you would like to request this record from the backend.

    _Note: This is a synchronous method and does not return a promise._

    **Example 1**

    ```js
    let post = store.peekRecord('post', 1);

    post.id; // 1
    ```

    `peekRecord` can be called with a single identifier argument instead of the combination
    of `type` (modelName) and `id` as separate arguments. You may recognize this combo as
    the typical pairing from [JSON:API](https://jsonapi.org/format/#document-resource-object-identification)

    **Example 2**

    ```js
    let post = store.peekRecord({ type: 'post', id });
    post.id; // 1
    ```

    If you have previously received an lid from an Identifier for this record, you can lookup the record again using
    just the lid.

    **Example 3**

    ```js
    let post = store.peekRecord({ lid });
    post.id; // 1
    ```


    @since 1.13.0
    @method peekRecord
    @public
    @param {String|object} modelName - either a string representing the modelName or a ResourceIdentifier object containing both the type (a string) and the id (a string) for the record or an lid (a string) of an existing record
    @param {String|Integer} id - optional only if the first param is a ResourceIdentifier, else the string id of the record to be retrieved.
    @return {Model|null} record
  */
  peekRecord(identifier: string, id: string | number): RecordInstance | null;
  peekRecord(identifier: ResourceIdentifierObject): RecordInstance | null;
  peekRecord(identifier: ResourceIdentifierObject | string, id?: string | number): RecordInstance | null {
    if (arguments.length === 1 && isMaybeIdentifier(identifier)) {
      const stableIdentifier = this.identifierCache.peekRecordIdentifier(identifier);
      const internalModel = stableIdentifier && internalModelFactoryFor(this).peek(stableIdentifier);
      // TODO come up with a better mechanism for determining if we have data and could peek.
      // this is basically an "are we not empty" query.
      return internalModel && internalModel.isLoaded ? this._instanceCache.getRecord(stableIdentifier) : null;
    }

    if (DEBUG) {
      assertDestroyingStore(this, 'peekRecord');
    }

    assert(`You need to pass a model name to the store's peekRecord method`, identifier);
    assert(
      `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${identifier}`,
      typeof identifier === 'string'
    );

    const type = normalizeModelName(identifier);
    const normalizedId = ensureStringId(id);
    const resource = { type, id: normalizedId };
    const stableIdentifier = this.identifierCache.peekRecordIdentifier(resource);
    const internalModel = stableIdentifier && internalModelFactoryFor(this).peek(stableIdentifier);

    return internalModel && internalModel.isLoaded ? this._instanceCache.getRecord(stableIdentifier) : null;
  }

  /**
   This method returns true if a record for a given modelName and id is already
   loaded in the store. Use this function to know beforehand if a findRecord()
   will result in a request or that it will be a cache hit.

   Example

   ```javascript
   store.hasRecordForId('post', 1); // false
   store.findRecord('post', 1).then(function() {
     store.hasRecordForId('post', 1); // true
   });
   ```

    @method hasRecordForId
    @public
    @param {String} modelName
    @param {(String|Integer)} id
    @return {Boolean}
  */
  hasRecordForId(modelName: string, id: string | number): boolean {
    if (DEPRECATE_HAS_RECORD) {
      deprecate(`store.hasRecordForId has been deprecated in favor of store.peekRecord`, false, {
        id: 'ember-data:deprecate-has-record-for-id',
        since: { available: '4.5', enabled: '4.5' },
        until: '5.0',
        for: 'ember-data',
      });
      if (DEBUG) {
        assertDestroyingStore(this, 'hasRecordForId');
      }
      assert(`You need to pass a model name to the store's hasRecordForId method`, modelName);
      assert(
        `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${modelName}`,
        typeof modelName === 'string'
      );

      const type = normalizeModelName(modelName);
      const trueId = ensureStringId(id);
      const resource = { type, id: trueId };

      const identifier = this.identifierCache.peekRecordIdentifier(resource);
      const internalModel = identifier && internalModelFactoryFor(this).peek(identifier);

      return !!internalModel && internalModel.isLoaded;
    }
    assert(`store.hasRecordForId has been removed`);
  }

  _findHasManyByJsonApiResource(
    resource,
    parentIdentifier: StableRecordIdentifier,
    relationship: ManyRelationship,
    options?: FindOptions
  ): Promise<void | unknown[]> {
    if (HAS_RECORD_DATA_PACKAGE) {
      if (!resource) {
        return resolve();
      }
      const { definition, state } = relationship;
      let adapter = this.adapterFor(definition.type);

      let { isStale, hasDematerializedInverse, hasReceivedData, isEmpty, shouldForceReload } = state;
      const allInverseRecordsAreLoaded = areAllInverseRecordsLoaded(this, resource);

      let shouldFindViaLink =
        resource.links &&
        resource.links.related &&
        (typeof adapter.findHasMany === 'function' || typeof resource.data === 'undefined') &&
        (shouldForceReload || hasDematerializedInverse || isStale || (!allInverseRecordsAreLoaded && !isEmpty));

      // fetch via link
      if (shouldFindViaLink) {
        // findHasMany, although not public, does not need to care about our upgrade relationship definitions
        // and can stick with the public definition API for now.
        const relationshipMeta = this._storeWrapper.relationshipsDefinitionFor(definition.inverseType)[definition.key];
        let adapter = this.adapterFor(parentIdentifier.type);

        /*
          If a relationship was originally populated by the adapter as a link
          (as opposed to a list of IDs), this method is called when the
          relationship is fetched.

          The link (which is usually a URL) is passed through unchanged, so the
          adapter can make whatever request it wants.

          The usual use-case is for the server to register a URL as a link, and
          then use that URL in the future to make a request for the relationship.
        */
        assert(
          `You tried to load a hasMany relationship but you have no adapter (for ${parentIdentifier.type})`,
          adapter
        );
        assert(
          `You tried to load a hasMany relationship from a specified 'link' in the original payload but your adapter does not implement 'findHasMany'`,
          typeof adapter.findHasMany === 'function'
        );

        return _findHasMany(adapter, this, parentIdentifier, resource.links.related, relationshipMeta, options);
      }

      let preferLocalCache = hasReceivedData && !isEmpty;

      let hasLocalPartialData =
        hasDematerializedInverse || (isEmpty && Array.isArray(resource.data) && resource.data.length > 0);

      // fetch using data, pulling from local cache if possible
      if (!shouldForceReload && !isStale && (preferLocalCache || hasLocalPartialData)) {
        let finds = new Array(resource.data.length);
        for (let i = 0; i < resource.data.length; i++) {
          let identifier = this.identifierCache.getOrCreateRecordIdentifier(resource.data[i]);
          finds[i] = this._fetchDataIfNeededForIdentifier(identifier, options);
        }

        return all(finds);
      }

      let hasData = hasReceivedData && !isEmpty;

      // fetch by data
      if (hasData || hasLocalPartialData) {
        let identifiers = resource.data.map((json) => this.identifierCache.getOrCreateRecordIdentifier(json));

        return this._scheduleFetchMany(identifiers, options);
      }

      // we were explicitly told we have no data and no links.
      //   TODO if the relationshipIsStale, should we hit the adapter anyway?
      return resolve();
    }
    assert(`hasMany only works with the @ember-data/record-data package`);
  }

  _findBelongsToByJsonApiResource(
    resource,
    parentIdentifier: StableRecordIdentifier,
    relationshipMeta,
    options: FindOptions = {}
  ): Promise<StableRecordIdentifier | null> {
    if (DEBUG) {
      assertDestroyingStore(this, '_findBelongsToByJsonApiResource');
    }
    if (!resource) {
      return resolve(null);
    }

    const internalModel = resource.data ? this._internalModelForResource(resource.data) : null;

    let { isStale, hasDematerializedInverse, hasReceivedData, isEmpty, shouldForceReload } = resource._relationship
      .state as RelationshipState;
    const allInverseRecordsAreLoaded = areAllInverseRecordsLoaded(this, resource);

    let shouldFindViaLink =
      resource.links &&
      resource.links.related &&
      (shouldForceReload || hasDematerializedInverse || isStale || (!allInverseRecordsAreLoaded && !isEmpty));

    if (internalModel) {
      // short circuit if we are already loading
      let pendingRequest = this._fetchManager.getPendingFetch(internalModel.identifier, options);
      if (pendingRequest) {
        return pendingRequest;
      }
    }

    // fetch via link
    if (shouldFindViaLink) {
      return _findBelongsTo(this, parentIdentifier, resource.links.related, relationshipMeta, options);
    }

    let preferLocalCache = hasReceivedData && allInverseRecordsAreLoaded && !isEmpty;
    let hasLocalPartialData = hasDematerializedInverse || (isEmpty && resource.data);
    // null is explicit empty, undefined is "we don't know anything"
    let localDataIsEmpty = resource.data === undefined || resource.data === null;

    // fetch using data, pulling from local cache if possible
    if (!shouldForceReload && !isStale && (preferLocalCache || hasLocalPartialData)) {
      /*
        We have canonical data, but our local state is empty
       */
      if (localDataIsEmpty) {
        return resolve(null);
      }

      if (!internalModel) {
        assert(`No InternalModel found for ${resource.lid}`, internalModel);
      }

      return this._fetchDataIfNeededForIdentifier(internalModel.identifier, options);
    }

    let resourceIsLocal = !localDataIsEmpty && resource.data.id === null;

    if (internalModel && resourceIsLocal) {
      return resolve(internalModel.identifier);
    }

    // fetch by data
    if (internalModel && !localDataIsEmpty) {
      let identifier = internalModel.identifier;
      assertIdentifierHasId(identifier);

      return this._fetchManager.scheduleFetch(identifier, options);
    }

    // we were explicitly told we have no data and no links.
    //   TODO if the relationshipIsStale, should we hit the adapter anyway?
    return resolve(null);
  }

  /**
    This method delegates a query to the adapter. This is the one place where
    adapter-level semantics are exposed to the application.

    Each time this method is called a new request is made through the adapter.

    Exposing queries this way seems preferable to creating an abstract query
    language for all server-side queries, and then require all adapters to
    implement them.

    ---

    If you do something like this:

    ```javascript
    store.query('person', { page: 1 });
    ```

    The request made to the server will look something like this:

    ```
    GET "/api/v1/person?page=1"
    ```

    ---

    If you do something like this:

    ```javascript
    store.query('person', { ids: [1, 2, 3] });
    ```

    The request made to the server will look something like this:

    ```
    GET "/api/v1/person?ids%5B%5D=1&ids%5B%5D=2&ids%5B%5D=3"
    decoded: "/api/v1/person?ids[]=1&ids[]=2&ids[]=3"
    ```

    This method returns a promise, which is resolved with an
    [`AdapterPopulatedRecordArray`](/ember-data/release/classes/AdapterPopulatedRecordArray)
    once the server returns.

    @since 1.13.0
    @method query
    @public
    @param {String} modelName
    @param {any} query an opaque query to be used by the adapter
    @param {Object} options optional, may include `adapterOptions` hash which will be passed to adapter.query
    @return {Promise} promise
  */
  query(modelName: string, query, options): PromiseArray<RecordInstance, AdapterPopulatedRecordArray> {
    if (DEBUG) {
      assertDestroyingStore(this, 'query');
    }
    assert(`You need to pass a model name to the store's query method`, modelName);
    assert(`You need to pass a query hash to the store's query method`, query);
    assert(
      `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${modelName}`,
      typeof modelName === 'string'
    );

    let adapterOptionsWrapper: { adapterOptions?: any } = {};

    if (options && options.adapterOptions) {
      adapterOptionsWrapper.adapterOptions = options.adapterOptions;
    }

    let normalizedModelName = normalizeModelName(modelName);
    return promiseArray(this._query(normalizedModelName, query, null, adapterOptionsWrapper));
  }

  _query(modelName: string, query, array, options): Promise<AdapterPopulatedRecordArray> {
    assert(`You need to pass a model name to the store's query method`, modelName);
    assert(`You need to pass a query hash to the store's query method`, query);
    assert(
      `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${modelName}`,
      typeof modelName === 'string'
    );

    let adapter = this.adapterFor(modelName);

    assert(`You tried to load a query but you have no adapter (for ${modelName})`, adapter);
    assert(
      `You tried to load a query but your adapter does not implement 'query'`,
      typeof adapter.query === 'function'
    );

    return _query(adapter, this, modelName, query, array, options) as unknown as Promise<AdapterPopulatedRecordArray>;
  }

  /**
    This method makes a request for one record, where the `id` is not known
    beforehand (if the `id` is known, use [`findRecord`](../methods/findRecord?anchor=findRecord)
    instead).

    This method can be used when it is certain that the server will return a
    single object for the primary data.

    Each time this method is called a new request is made through the adapter.

    Let's assume our API provides an endpoint for the currently logged in user
    via:

    ```
    // GET /api/current_user
    {
      user: {
        id: 1234,
        username: 'admin'
      }
    }
    ```

    Since the specific `id` of the `user` is not known beforehand, we can use
    `queryRecord` to get the user:

    ```javascript
    store.queryRecord('user', {}).then(function(user) {
      let username = user.get('username');
      console.log(`Currently logged in as ${username}`);
    });
    ```

    The request is made through the adapters' `queryRecord`:

    ```app/adapters/user.js
    import Adapter from '@ember-data/adapter';
    import $ from 'jquery';

    export default class UserAdapter extends Adapter {
      queryRecord(modelName, query) {
        return $.getJSON('/api/current_user');
      }
    }
    ```

    Note: the primary use case for `store.queryRecord` is when a single record
    is queried and the `id` is not known beforehand. In all other cases
    `store.query` and using the first item of the array is likely the preferred
    way:

    ```
    // GET /users?username=unique
    {
      data: [{
        id: 1234,
        type: 'user',
        attributes: {
          username: "unique"
        }
      }]
    }
    ```

    ```javascript
    store.query('user', { username: 'unique' }).then(function(users) {
      return users.get('firstObject');
    }).then(function(user) {
      let id = user.get('id');
    });
    ```

    This method returns a promise, which resolves with the found record.

    If the adapter returns no data for the primary data of the payload, then
    `queryRecord` resolves with `null`:

    ```
    // GET /users?username=unique
    {
      data: null
    }
    ```

    ```javascript
    store.queryRecord('user', { username: 'unique' }).then(function(user) {
      console.log(user); // null
    });
    ```

    @since 1.13.0
    @method queryRecord
    @public
    @param {String} modelName
    @param {any} query an opaque query to be used by the adapter
    @param {Object} options optional, may include `adapterOptions` hash which will be passed to adapter.queryRecord
    @return {Promise} promise which resolves with the found record or `null`
  */
  queryRecord(modelName: string, query, options?): PromiseObject<RecordInstance | null> {
    if (DEBUG) {
      assertDestroyingStore(this, 'queryRecord');
    }
    assert(`You need to pass a model name to the store's queryRecord method`, modelName);
    assert(`You need to pass a query hash to the store's queryRecord method`, query);
    assert(
      `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${modelName}`,
      typeof modelName === 'string'
    );

    let normalizedModelName = normalizeModelName(modelName);
    let adapter = this.adapterFor(normalizedModelName);
    let adapterOptionsWrapper: { adapterOptions?: any } = {};

    if (options && options.adapterOptions) {
      adapterOptionsWrapper.adapterOptions = options.adapterOptions;
    }

    assert(`You tried to make a query but you have no adapter (for ${normalizedModelName})`, adapter);
    assert(
      `You tried to make a query but your adapter does not implement 'queryRecord'`,
      typeof adapter.queryRecord === 'function'
    );

    const promise: Promise<StableRecordIdentifier | null> = _queryRecord(
      adapter,
      this,
      normalizedModelName,
      query,
      adapterOptionsWrapper
    ) as Promise<StableRecordIdentifier | null>;

    return promiseObject(promise.then((identifier) => identifier && this.peekRecord(identifier)));
  }

  /**
    `findAll` asks the adapter's `findAll` method to find the records for the
    given type, and returns a promise which will resolve with all records of
    this type present in the store, even if the adapter only returns a subset
    of them.

    ```app/routes/authors.js
    import Route from '@ember/routing/route';

    export default class AuthorsRoute extends Route {
      model(params) {
        return this.store.findAll('author');
      }
    }
    ```

    _When_ the returned promise resolves depends on the reload behavior,
    configured via the passed `options` hash and the result of the adapter's
    `shouldReloadAll` method.

    ### Reloading

    If `{ reload: true }` is passed or `adapter.shouldReloadAll` evaluates to
    `true`, then the returned promise resolves once the adapter returns data,
    regardless if there are already records in the store:

    ```js
    store.push({
      data: {
        id: 'first',
        type: 'author'
      }
    });

    // adapter#findAll resolves with
    // [
    //   {
    //     id: 'second',
    //     type: 'author'
    //   }
    // ]
    store.findAll('author', { reload: true }).then(function(authors) {
      authors.getEach('id'); // ['first', 'second']
    });
    ```

    If no reload is indicated via the above mentioned ways, then the promise
    immediately resolves with all the records currently loaded in the store.

    ### Background Reloading

    Optionally, if `adapter.shouldBackgroundReloadAll` evaluates to `true`,
    then a background reload is started. Once this resolves, the array with
    which the promise resolves, is updated automatically so it contains all the
    records in the store:

    ```app/adapters/application.js
    import Adapter from '@ember-data/adapter';

    export default class ApplicationAdapter extends Adapter {
      shouldReloadAll(store, snapshotsArray) {
        return false;
      },

      shouldBackgroundReloadAll(store, snapshotsArray) {
        return true;
      }
    });

    // ...

    store.push({
      data: {
        id: 'first',
        type: 'author'
      }
    });

    let allAuthors;
    store.findAll('author').then(function(authors) {
      authors.getEach('id'); // ['first']

      allAuthors = authors;
    });

    // later, once adapter#findAll resolved with
    // [
    //   {
    //     id: 'second',
    //     type: 'author'
    //   }
    // ]

    allAuthors.getEach('id'); // ['first', 'second']
    ```

    If you would like to force or prevent background reloading, you can set a
    boolean value for `backgroundReload` in the options object for
    `findAll`.

    ```app/routes/post/edit.js
    import Route from '@ember/routing/route';

    export default class PostEditRoute extends Route {
      model() {
        return this.store.findAll('post', { backgroundReload: false });
      }
    }
    ```

    If you pass an object on the `adapterOptions` property of the options
    argument it will be passed to you adapter via the `snapshotRecordArray`

    ```app/routes/posts.js
    import Route from '@ember/routing/route';

    export default class PostsRoute extends Route {
      model(params) {
        return this.store.findAll('post', {
          adapterOptions: { subscribe: false }
        });
      }
    }
    ```

    ```app/adapters/post.js
    import MyCustomAdapter from './custom-adapter';

    export default class UserAdapter extends MyCustomAdapter {
      findAll(store, type, sinceToken, snapshotRecordArray) {
        if (snapshotRecordArray.adapterOptions.subscribe) {
          // ...
        }
        // ...
      }
    }
    ```

    See [peekAll](../methods/peekAll?anchor=peekAll) to get an array of current records in the
    store, without waiting until a reload is finished.

    ### Retrieving Related Model Records

    If you use an adapter such as Ember's default
    [`JSONAPIAdapter`](/ember-data/release/classes/JSONAPIAdapter)
    that supports the [JSON API specification](http://jsonapi.org/) and if your server
    endpoint supports the use of an
    ['include' query parameter](http://jsonapi.org/format/#fetching-includes),
    you can use `findAll()` to automatically retrieve additional records related to
    those requested by supplying an `include` parameter in the `options` object.

    For example, given a `post` model that has a `hasMany` relationship with a `comment`
    model, when we retrieve all of the post records we can have the server also return
    all of the posts' comments in the same request:

    ```app/routes/posts.js
    import Route from '@ember/routing/route';

    export default class PostsRoute extends Route {
      model() {
        return this.store.findAll('post', { include: 'comments' });
      }
    }
    ```
    Multiple relationships can be requested using an `include` parameter consisting of a
    comma-separated list (without white-space) while nested relationships can be specified
    using a dot-separated sequence of relationship names. So to request both the posts'
    comments and the authors of those comments the request would look like this:

    ```app/routes/posts.js
    import Route from '@ember/routing/route';

    export default class PostsRoute extends Route {
      model() {
        return this.store.findAll('post', { include: 'comments,comments.author' });
      }
    }
    ```

    See [query](../methods/query?anchor=query) to only get a subset of records from the server.

    @since 1.13.0
    @method findAll
    @public
    @param {String} modelName
    @param {Object} options
    @return {Promise} promise
  */
  findAll(
    modelName: string,
    options: { reload?: boolean; backgroundReload?: boolean } = {}
  ): PromiseArray<RecordInstance, RecordArray> {
    if (DEBUG) {
      assertDestroyingStore(this, 'findAll');
    }
    assert(`You need to pass a model name to the store's findAll method`, modelName);
    assert(
      `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${modelName}`,
      typeof modelName === 'string'
    );

    let normalizedModelName = normalizeModelName(modelName);
    let array = this.peekAll(normalizedModelName);
    let fetch;

    let adapter = this.adapterFor(normalizedModelName);

    assert(`You tried to load all records but you have no adapter (for ${normalizedModelName})`, adapter);
    assert(
      `You tried to load all records but your adapter does not implement 'findAll'`,
      typeof adapter.findAll === 'function'
    );

    if (options.reload) {
      array.isUpdating = true;
      fetch = _findAll(adapter, this, normalizedModelName, options);
    } else {
      let snapshotArray = array._createSnapshot(options);

      if (options.reload !== false) {
        if (
          (adapter.shouldReloadAll && adapter.shouldReloadAll(this, snapshotArray)) ||
          (!adapter.shouldReloadAll && snapshotArray.length === 0)
        ) {
          array.isUpdating = true;
          fetch = _findAll(adapter, this, modelName, options);
        }
      }

      if (!fetch) {
        if (options.backgroundReload === false) {
          fetch = resolve(array);
        } else if (
          options.backgroundReload ||
          !adapter.shouldBackgroundReloadAll ||
          adapter.shouldBackgroundReloadAll(this, snapshotArray)
        ) {
          array.isUpdating = true;
          _findAll(adapter, this, modelName, options);
        }

        fetch = resolve(array);
      }
    }

    return promiseArray(fetch);
  }

  /**
    This method returns a filtered array that contains all of the
    known records for a given type in the store.

    Note that because it's just a filter, the result will contain any
    locally created records of the type, however, it will not make a
    request to the backend to retrieve additional records. If you
    would like to request all the records from the backend please use
    [store.findAll](../methods/findAll?anchor=findAll).

    Also note that multiple calls to `peekAll` for a given type will always
    return the same `RecordArray`.

    Example

    ```javascript
    let localPosts = store.peekAll('post');
    ```

    @since 1.13.0
    @method peekAll
    @public
    @param {String} modelName
    @return {RecordArray}
  */
  peekAll(modelName) {
    if (DEBUG) {
      assertDestroyingStore(this, 'peekAll');
    }
    assert(`You need to pass a model name to the store's peekAll method`, modelName);
    assert(
      `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${modelName}`,
      typeof modelName === 'string'
    );
    let normalizedModelName = normalizeModelName(modelName);
    return this.recordArrayManager.liveRecordArrayFor(normalizedModelName);
  }

  /**
    This method unloads all records in the store.
    It schedules unloading to happen during the next run loop.

    Optionally you can pass a type which unload all records for a given type.

    ```javascript
    store.unloadAll();
    store.unloadAll('post');
    ```

    @method unloadAll
    @public
    @param {String} modelName
  */
  unloadAll(modelName?: string) {
    if (DEBUG) {
      assertDestroyedStoreOnly(this, 'unloadAll');
    }
    assert(
      `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${modelName}`,
      !modelName || typeof modelName === 'string'
    );

    const factory = internalModelFactoryFor(this);

    if (modelName === undefined) {
      factory.clear();
    } else {
      let normalizedModelName = normalizeModelName(modelName);
      factory.clear(normalizedModelName);
    }
  }

  // ..............
  // . PERSISTING .
  // ..............

  /**
    This method is called once the promise returned by an
    adapter's `createRecord`, `updateRecord` or `deleteRecord`
    is rejected with a `InvalidError`.

    @method recordWasInvalid
    @private
    @deprecated
    @param {InternalModel} internalModel
    @param {Object} errors
  */
  recordWasInvalid(internalModel, parsedErrors, error) {
    if (DEPRECATE_RECORD_WAS_INVALID) {
      deprecate(
        `The private API recordWasInvalid will be removed in an upcoming release. Use record.errors add/remove instead if the intent was to move the record into an invalid state manually.`,
        false,
        {
          id: 'ember-data:deprecate-record-was-invalid',
          for: 'ember-data',
          until: '5.0',
          since: { enabled: '4.5', available: '4.5' },
        }
      );
      if (DEBUG) {
        assertDestroyingStore(this, 'recordWasInvalid');
      }
      internalModel.adapterDidInvalidate(parsedErrors, error);
    }
    assert(`store.recordWasInvalid has been removed`);
  }

  /**
    Sets newly received ID from the adapter's `createRecord`, `updateRecord`
    or `deleteRecord`.

    @method setRecordId
    @private
    @param {String} modelName
    @param {string} newId
    @param {string} clientId
   */
  // TODO move this into one of the caches
  setRecordId(modelName: string, newId: string, clientId: string) {
    if (DEBUG) {
      assertDestroyingStore(this, 'setRecordId');
    }
    internalModelFactoryFor(this).setRecordId(modelName, newId, clientId);
  }

  // ................
  // . LOADING DATA .
  // ................

  /**
    This internal method is used by `push`.

    @method _load
    @private
    @param {Object} data
  */
  _load(data: ExistingResourceObject): StableExistingRecordIdentifier {
    // TODO type should be pulled from the identifier for debug
    let modelName = data.type;
    assert(
      `You must include an 'id' for ${modelName} in an object passed to 'push'`,
      data.id !== null && data.id !== undefined && data.id !== ''
    );
    assert(
      `You tried to push data with a type '${modelName}' but no model could be found with that name.`,
      this.getSchemaDefinitionService().doesTypeExist(modelName)
    );

    if (DEBUG) {
      // If ENV.DS_WARN_ON_UNKNOWN_KEYS is set to true and the payload
      // contains unknown attributes or relationships, log a warning.

      // TODO @runspired @deprecate in favor of a build-time config not in ENV
      if (ENV.DS_WARN_ON_UNKNOWN_KEYS) {
        let unknownAttributes, unknownRelationships;
        let relationships = this.getSchemaDefinitionService().relationshipsDefinitionFor({ type: modelName });
        let attributes = this.getSchemaDefinitionService().attributesDefinitionFor({ type: modelName });
        // Check unknown attributes
        unknownAttributes = Object.keys(data.attributes || {}).filter((key) => {
          return !attributes[key];
        });

        // Check unknown relationships
        unknownRelationships = Object.keys(data.relationships || {}).filter((key) => {
          return !relationships[key];
        });
        let unknownAttributesMessage = `The payload for '${modelName}' contains these unknown attributes: ${unknownAttributes}. Make sure they've been defined in your model.`;
        warn(unknownAttributesMessage, unknownAttributes.length === 0, {
          id: 'ds.store.unknown-keys-in-payload',
        });

        let unknownRelationshipsMessage = `The payload for '${modelName}' contains these unknown relationships: ${unknownRelationships}. Make sure they've been defined in your model.`;
        warn(unknownRelationshipsMessage, unknownRelationships.length === 0, {
          id: 'ds.store.unknown-keys-in-payload',
        });
      }
    }

    // TODO this should determine identifier via the cache before making assumptions
    const resource = constructResource(normalizeModelName(data.type), ensureStringId(data.id), coerceId(data.lid));
    const maybeIdentifier = this.identifierCache.peekRecordIdentifier(resource);

    let internalModel = internalModelFactoryFor(this).lookup(resource, data);

    // store.push will be from empty
    // findRecord will be from root.loading
    // this cannot be loading state if we do not already have an identifier
    // all else will be updates
    const isLoading = internalModel.isLoading || (!internalModel.isLoaded && maybeIdentifier);
    const isUpdate = internalModel.isEmpty === false && !isLoading;

    // exclude store.push (root.empty) case
    let identifier = internalModel.identifier;
    if (isUpdate || isLoading) {
      let updatedIdentifier = this.identifierCache.updateRecordIdentifier(identifier, data);

      if (updatedIdentifier !== identifier) {
        // we encountered a merge of identifiers in which
        // two identifiers (and likely two internalModels)
        // existed for the same resource. Now that we have
        // determined the correct identifier to use, make sure
        // that we also use the correct internalModel.
        identifier = updatedIdentifier;
        internalModel = internalModelFactoryFor(this).lookup(identifier);
      }
    }

    internalModel.setupData(data);

    if (!isUpdate) {
      this.recordArrayManager.recordDidChange(identifier);
    }

    return identifier as StableExistingRecordIdentifier;
  }

  /**
    Push some data for a given type into the store.

    This method expects normalized [JSON API](http://jsonapi.org/) document. This means you have to follow [JSON API specification](http://jsonapi.org/format/) with few minor adjustments:
    - record's `type` should always be in singular, dasherized form
    - members (properties) should be camelCased

    [Your primary data should be wrapped inside `data` property](http://jsonapi.org/format/#document-top-level):

    ```js
    store.push({
      data: {
        // primary data for single record of type `Person`
        id: '1',
        type: 'person',
        attributes: {
          firstName: 'Daniel',
          lastName: 'Kmak'
        }
      }
    });
    ```

    [Demo.](http://ember-twiddle.com/fb99f18cd3b4d3e2a4c7)

    `data` property can also hold an array (of records):

    ```js
    store.push({
      data: [
        // an array of records
        {
          id: '1',
          type: 'person',
          attributes: {
            firstName: 'Daniel',
            lastName: 'Kmak'
          }
        },
        {
          id: '2',
          type: 'person',
          attributes: {
            firstName: 'Tom',
            lastName: 'Dale'
          }
        }
      ]
    });
    ```

    [Demo.](http://ember-twiddle.com/69cdbeaa3702159dc355)

    There are some typical properties for `JSONAPI` payload:
    * `id` - mandatory, unique record's key
    * `type` - mandatory string which matches `model`'s dasherized name in singular form
    * `attributes` - object which holds data for record attributes - `attr`'s declared in model
    * `relationships` - object which must contain any of the following properties under each relationships' respective key (example path is `relationships.achievements.data`):
      - [`links`](http://jsonapi.org/format/#document-links)
      - [`data`](http://jsonapi.org/format/#document-resource-object-linkage) - place for primary data
      - [`meta`](http://jsonapi.org/format/#document-meta) - object which contains meta-information about relationship

    For this model:

    ```app/models/person.js
    import Model, { attr, hasMany } from '@ember-data/model';

    export default class PersonRoute extends Route {
      @attr('string') firstName;
      @attr('string') lastName;

      @hasMany('person') children;
    }
    ```

    To represent the children as IDs:

    ```js
    {
      data: {
        id: '1',
        type: 'person',
        attributes: {
          firstName: 'Tom',
          lastName: 'Dale'
        },
        relationships: {
          children: {
            data: [
              {
                id: '2',
                type: 'person'
              },
              {
                id: '3',
                type: 'person'
              },
              {
                id: '4',
                type: 'person'
              }
            ]
          }
        }
      }
    }
    ```

    [Demo.](http://ember-twiddle.com/343e1735e034091f5bde)

    To represent the children relationship as a URL:

    ```js
    {
      data: {
        id: '1',
        type: 'person',
        attributes: {
          firstName: 'Tom',
          lastName: 'Dale'
        },
        relationships: {
          children: {
            links: {
              related: '/people/1/children'
            }
          }
        }
      }
    }
    ```

    If you're streaming data or implementing an adapter, make sure
    that you have converted the incoming data into this form. The
    store's [normalize](../methods/normalize?anchor=normalize) method is a convenience
    helper for converting a json payload into the form Ember Data
    expects.

    ```js
    store.push(store.normalize('person', data));
    ```

    This method can be used both to push in brand new
    records, as well as to update existing records.

    @method push
    @public
    @param {Object} data
    @return the record(s) that was created or
      updated.
  */
  push(data: EmptyResourceDocument): null;
  push(data: SingleResourceDocument): RecordInstance;
  push(data: CollectionResourceDocument): RecordInstance[];
  push(data: JsonApiDocument): RecordInstance | RecordInstance[] | null {
    if (DEBUG) {
      assertDestroyingStore(this, 'push');
    }
    let pushed = this._push(data);

    if (Array.isArray(pushed)) {
      let records = pushed.map((identifier) => this._instanceCache.getRecord(identifier));
      return records;
    }

    if (pushed === null) {
      return null;
    }

    return this._instanceCache.getRecord(pushed);
  }

  /**
    Push some data in the form of a json-api document into the store,
    without creating materialized records.

    @method _push
    @private
    @param {Object} jsonApiDoc
    @return {InternalModel|Array<InternalModel>} pushed InternalModel(s)
  */
  _push(jsonApiDoc): StableExistingRecordIdentifier | StableExistingRecordIdentifier[] | null {
    if (DEBUG) {
      assertDestroyingStore(this, '_push');
    }
    let identifiers = this._backburner.join(() => {
      let included = jsonApiDoc.included;
      let i, length;

      if (included) {
        for (i = 0, length = included.length; i < length; i++) {
          this._load(included[i]);
        }
      }

      if (Array.isArray(jsonApiDoc.data)) {
        length = jsonApiDoc.data.length;
        let identifiers = new Array(length);

        for (i = 0; i < length; i++) {
          identifiers[i] = this._load(jsonApiDoc.data[i]);
        }
        return identifiers;
      }

      if (jsonApiDoc.data === null) {
        return null;
      }

      assert(
        `Expected an object in the 'data' property in a call to 'push' for ${
          jsonApiDoc.type
        }, but was ${typeof jsonApiDoc.data}`,
        typeof jsonApiDoc.data === 'object'
      );

      return this._load(jsonApiDoc.data);
    });

    // this typecast is necessary because `backburner.join` is mistyped to return void
    return identifiers;
  }

  /**
    Push some raw data into the store.

    This method can be used both to push in brand new
    records, as well as to update existing records. You
    can push in more than one type of object at once.
    All objects should be in the format expected by the
    serializer.

    ```app/serializers/application.js
    import RESTSerializer from '@ember-data/serializer/rest';

    export default class ApplicationSerializer extends RESTSerializer;
    ```

    ```js
    let pushData = {
      posts: [
        { id: 1, postTitle: "Great post", commentIds: [2] }
      ],
      comments: [
        { id: 2, commentBody: "Insightful comment" }
      ]
    }

    store.pushPayload(pushData);
    ```

    By default, the data will be deserialized using a default
    serializer (the application serializer if it exists).

    Alternatively, `pushPayload` will accept a model type which
    will determine which serializer will process the payload.

    ```app/serializers/application.js
    import RESTSerializer from '@ember-data/serializer/rest';

     export default class ApplicationSerializer extends RESTSerializer;
    ```

    ```app/serializers/post.js
    import JSONSerializer from '@ember-data/serializer/json';

    export default JSONSerializer;
    ```

    ```js
    store.pushPayload(pushData); // Will use the application serializer
    store.pushPayload('post', pushData); // Will use the post serializer
    ```

    @method pushPayload
    @public
    @param {String} modelName Optionally, a model type used to determine which serializer will be used
    @param {Object} inputPayload
  */
  // TODO @runspired @deprecate pushPayload in favor of looking up the serializer
  pushPayload(modelName, inputPayload) {
    if (DEBUG) {
      assertDestroyingStore(this, 'pushPayload');
    }
    let serializer;
    let payload;
    if (!inputPayload) {
      payload = modelName;
      serializer = this.serializerFor('application');
      assert(
        `You cannot use 'store#pushPayload' without a modelName unless your default serializer defines 'pushPayload'`,
        typeof serializer.pushPayload === 'function'
      );
    } else {
      payload = inputPayload;
      assert(
        `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${modelName}`,
        typeof modelName === 'string'
      );
      let normalizedModelName = normalizeModelName(modelName);
      serializer = this.serializerFor(normalizedModelName);
    }
    assert(
      `You must define a pushPayload method in your serializer in order to call store.pushPayload`,
      serializer.pushPayload
    );
    serializer.pushPayload(this, payload);
  }

  // TODO string candidate for early elimination
  _internalModelForResource(resource: ResourceIdentifierObject): InternalModel {
    return internalModelFactoryFor(this).getByResource(resource);
  }

  // TODO @runspired @deprecate records should implement their own serialization if desired
  serializeRecord(record: RecordInstance, options?: Dict<unknown>): unknown {
    // TODO we used to check if the record was destroyed here
    return this._instanceCache.createSnapshot(recordIdentifierFor(record)).serialize(options);
  }

  // todo @runspired this should likely be publicly documented for custom records
  saveRecord(record: RecordInstance, options: Dict<unknown> = {}): Promise<RecordInstance> {
    assert(`Unable to initate save for a record in a disconnected state`, storeFor(record));
    let identifier = recordIdentifierFor(record);
    let internalModel = identifier && internalModelFactoryFor(this).peek(identifier)!;

    if (!internalModel) {
      // this commonly means we're disconnected
      // but just in case we reject here to prevent bad things.
      return reject(`Record Is Disconnected`);
    }
    // TODO we used to check if the record was destroyed here
    // Casting can be removed once REQUEST_SERVICE ff is turned on
    // because a `Record` is provided there will always be a matching internalModel

    assert(
      `Cannot initiate a save request for an unloaded record: ${identifier}`,
      !internalModel.isEmpty && !internalModel.isDestroyed
    );
    if (internalModel._isRecordFullyDeleted()) {
      return resolve(record);
    }

    internalModel.adapterWillCommit();

    if (!options) {
      options = {};
    }
    let recordData = this._instanceCache.getRecordData(identifier);
    let operation: 'createRecord' | 'deleteRecord' | 'updateRecord' = 'updateRecord';

    // TODO handle missing isNew
    if (recordData.isNew && recordData.isNew()) {
      operation = 'createRecord';
    } else if (recordData.isDeleted && recordData.isDeleted()) {
      operation = 'deleteRecord';
    }

    const saveOptions = Object.assign({ [SaveOp]: operation }, options);
    let fetchManagerPromise = this._fetchManager.scheduleSave(identifier, saveOptions);
    return fetchManagerPromise.then(
      (payload) => {
        /*
        // TODO @runspired re-evaluate the below claim now that
        // the save request pipeline is more streamlined.

        Note to future spelunkers hoping to optimize.
        We rely on this `run` to create a run loop if needed
        that `store._push` and `store.saveRecord` will both share.

        We use `join` because it is often the case that we
        have an outer run loop available still from the first
        call to `store._push`;
       */
        this._backburner.join(() => {
          if (DEBUG) {
            assertDestroyingStore(this, 'saveRecord');
          }

          let data = payload && payload.data;
          if (!data) {
            assert(
              `Your ${internalModel.modelName} record was saved to the server, but the response does not have an id and no id has been set client side. Records must have ids. Please update the server response to provide an id in the response or generate the id on the client side either before saving the record or while normalizing the response.`,
              internalModel.id
            );
          }

          const cache = this.identifierCache;
          if (operation !== 'deleteRecord' && data) {
            cache.updateRecordIdentifier(identifier, data);
          }

          //We first make sure the primary data has been updated
          //TODO try to move notification to the user to the end of the runloop
          internalModel.adapterDidCommit(data);

          if (payload && payload.included) {
            this._push({ data: null, included: payload.included });
          }
        });
        return record;
      },
      (e) => {
        if (typeof e === 'string') {
          throw e;
        }
        const { error, parsedErrors } = e;
        internalModel.adapterDidInvalidate(parsedErrors, error);
        throw error;
      }
    );
  }

  // TODO move this to InstanceCache
  // TODO this is probably a public API from custom model classes? If not move to InstanceCache
  // TODO probably just deprecate this. There seems to be zero usage.
  relationshipReferenceFor(identifier: RecordIdentifier, key: string): BelongsToReference | HasManyReference {
    let stableIdentifier = this.identifierCache.getOrCreateRecordIdentifier(identifier);
    let internalModel = internalModelFactoryFor(this).peek(stableIdentifier);
    // TODO we used to check if the record was destroyed here
    return internalModel!.referenceFor(null, key);
  }

  /**
   * Manages setting setting up the recordData returned by createRecordDataFor
   *
   * @method _createRecordData
   * @internal
   */
  // TODO move this to InstanceCache
  _createRecordData(identifier: StableRecordIdentifier): RecordData {
    const recordData = this.createRecordDataFor(identifier.type, identifier.id, identifier.lid, this._storeWrapper);
    setRecordDataFor(identifier, recordData);
    // TODO this is invalid for v2 recordData but required
    // for v1 recordData. Remember to remove this once the
    // RecordData manager handles converting recordData to identifier
    setRecordIdentifier(recordData, identifier);
    return recordData;
  }

  /**
   * Instantiation hook allowing applications or addons to configure the store
   * to utilize a custom RecordData implementation.
   *
   * @method createRecordDataFor
   * @public
   * @param modelName
   * @param id
   * @param clientId
   * @param storeWrapper
   */
  createRecordDataFor(
    modelName: string,
    id: string | null,
    clientId: string,
    storeWrapper: RecordDataStoreWrapper
  ): RecordData {
    if (HAS_RECORD_DATA_PACKAGE) {
      // we can't greedily use require as this causes
      // a cycle we can't easily fix (or clearly pin point) at present.
      //
      // it can be reproduced in partner tests by running
      // node ./scripts/packages-for-commit.js && yarn test-external:ember-observer
      if (_RecordData === undefined) {
        _RecordData = (
          importSync('@ember-data/record-data/-private') as typeof import('@ember-data/record-data/-private')
        ).RecordData as RecordDataConstruct;
      }

      let identifier = this.identifierCache.getOrCreateRecordIdentifier({
        type: modelName,
        id,
        lid: clientId,
      });
      return new _RecordData(identifier, storeWrapper);
    }

    assert(`Expected store.createRecordDataFor to be implemented but it wasn't`);
  }

  /**
   * @internal
   */

  // TODO move this to InstanceCache private property
  __recordDataFor(resource: RecordIdentifier) {
    const identifier = this.identifierCache.getOrCreateRecordIdentifier(resource);
    return this.recordDataFor(identifier, false);
  }

  /**
   * @internal
   */
  // TODO move this to InstanceCache
  recordDataFor(identifier: StableRecordIdentifier | { type: string }, isCreate: boolean): RecordData {
    let recordData: RecordData;
    if (isCreate === true) {
      // TODO remove once InternalModel is no longer essential to internal state
      // and just build a new identifier directly
      let internalModel = internalModelFactoryFor(this).build({ type: identifier.type, id: null });
      let stableIdentifier = internalModel.identifier;
      recordData = this._instanceCache.getRecordData(stableIdentifier);
      recordData.clientDidCreate();
      this.recordArrayManager.recordDidChange(stableIdentifier);
    } else {
      // TODO remove once InternalModel is no longer essential to internal state
      internalModelFactoryFor(this).lookup(identifier as StableRecordIdentifier);
      recordData = this._instanceCache.getRecordData(identifier as StableRecordIdentifier);
    }

    return recordData;
  }

  /**
    `normalize` converts a json payload into the normalized form that
    [push](../methods/push?anchor=push) expects.

    Example

    ```js
    socket.on('message', function(message) {
      let modelName = message.model;
      let data = message.data;
      store.push(store.normalize(modelName, data));
    });
    ```

    @method normalize
    @public
    @param {String} modelName The name of the model type for this payload
    @param {Object} payload
    @return {Object} The normalized payload
  */
  // TODO @runspired @deprecate users should call normalize on the associated serializer directly
  normalize(modelName: string, payload) {
    if (DEBUG) {
      assertDestroyingStore(this, 'normalize');
    }
    assert(`You need to pass a model name to the store's normalize method`, modelName);
    assert(
      `Passing classes to store methods has been removed. Please pass a dasherized string instead of ${inspect(
        modelName
      )}`,
      typeof modelName === 'string'
    );
    let normalizedModelName = normalizeModelName(modelName);
    let serializer = this.serializerFor(normalizedModelName);
    let model = this.modelFor(normalizedModelName);
    assert(
      `You must define a normalize method in your serializer in order to call store.normalize`,
      serializer?.normalize
    );
    return serializer.normalize(model, payload);
  }

  // ...............
  // . DESTRUCTION .
  // ...............

  /**
   * TODO remove test usage
   *
   * @internal
   */
  _internalModelsFor(modelName: string) {
    return internalModelFactoryFor(this).modelMapFor(modelName);
  }

  // ......................
  // . PER-TYPE ADAPTERS
  // ......................

  /**
    Returns an instance of the adapter for a given type. For
    example, `adapterFor('person')` will return an instance of
    the adapter located at `app/adapters/person.js`

    If no `person` adapter is found, this method will look
    for an `application` adapter (the default adapter for
    your entire application).

    @method adapterFor
    @public
    @param {String} modelName
    @return Adapter
  */
  adapterFor(modelName: string) {
    if (DEBUG) {
      assertDestroyingStore(this, 'adapterFor');
    }
    assert(`You need to pass a model name to the store's adapterFor method`, modelName);
    assert(
      `Passing classes to store.adapterFor has been removed. Please pass a dasherized string instead of ${modelName}`,
      typeof modelName === 'string'
    );
    let normalizedModelName = normalizeModelName(modelName);

    let { _adapterCache } = this;
    let adapter = _adapterCache[normalizedModelName];
    if (adapter) {
      return adapter;
    }

    let owner: any = getOwner(this);

    // name specific adapter
    adapter = owner.lookup(`adapter:${normalizedModelName}`);
    if (adapter !== undefined) {
      _adapterCache[normalizedModelName] = adapter;
      return adapter;
    }

    // no adapter found for the specific name, fallback and check for application adapter
    adapter = _adapterCache.application || owner.lookup('adapter:application');
    if (adapter !== undefined) {
      _adapterCache[normalizedModelName] = adapter;
      _adapterCache.application = adapter;
      return adapter;
    }

    if (DEPRECATE_JSON_API_FALLBACK) {
      // final fallback, no model specific adapter, no application adapter, no
      // `adapter` property on store: use json-api adapter
      adapter = _adapterCache['-json-api'] || owner.lookup('adapter:-json-api');
      if (adapter !== undefined) {
        deprecate(
          `Your application is utilizing a deprecated hidden fallback adapter (-json-api). Please implement an application adapter to function as your fallback.`,
          false,
          {
            id: 'ember-data:deprecate-secret-adapter-fallback',
            for: 'ember-data',
            until: '5.0',
            since: { available: '4.5', enabled: '4.5' },
          }
        );
        _adapterCache[normalizedModelName] = adapter;
        _adapterCache['-json-api'] = adapter;

        return adapter;
      }
    }

    assert(`No adapter was found for '${modelName}' and no 'application' adapter was found as a fallback.`);
  }

  // ..............................
  // . RECORD CHANGE NOTIFICATION .
  // ..............................

  /**
    Returns an instance of the serializer for a given type. For
    example, `serializerFor('person')` will return an instance of
    `App.PersonSerializer`.

    If no `App.PersonSerializer` is found, this method will look
    for an `App.ApplicationSerializer` (the default serializer for
    your entire application).

    If a serializer cannot be found on the adapter, it will fall back
    to an instance of `JSONSerializer`.

    @method serializerFor
    @public
    @param {String} modelName the record to serialize
    @return {Serializer}
  */
  serializerFor(modelName: string): MinimumSerializerInterface | null {
    if (DEBUG) {
      assertDestroyingStore(this, 'serializerFor');
    }
    assert(`You need to pass a model name to the store's serializerFor method`, modelName);
    assert(
      `Passing classes to store.serializerFor has been removed. Please pass a dasherized string instead of ${modelName}`,
      typeof modelName === 'string'
    );
    let normalizedModelName = normalizeModelName(modelName);

    let { _serializerCache } = this;
    let serializer = _serializerCache[normalizedModelName];
    if (serializer) {
      return serializer;
    }

    let owner: any = getOwner(this);

    // by name
    serializer = owner.lookup(`serializer:${normalizedModelName}`);
    if (serializer !== undefined) {
      _serializerCache[normalizedModelName] = serializer;
      return serializer;
    }

    // no serializer found for the specific model, fallback and check for application serializer
    serializer = _serializerCache.application || owner.lookup('serializer:application');
    if (serializer !== undefined) {
      _serializerCache[normalizedModelName] = serializer;
      _serializerCache.application = serializer;
      return serializer;
    }

    return null;
  }

  destroy() {
    // enqueue destruction of any adapters/serializers we have created
    for (let adapterName in this._adapterCache) {
      let adapter = this._adapterCache[adapterName]!;
      if (typeof adapter.destroy === 'function') {
        adapter.destroy();
      }
    }

    for (let serializerName in this._serializerCache) {
      let serializer = this._serializerCache[serializerName]!;
      if (typeof serializer.destroy === 'function') {
        serializer.destroy();
      }
    }

    if (HAS_RECORD_DATA_PACKAGE) {
      const peekGraph = (
        importSync('@ember-data/record-data/-private') as typeof import('@ember-data/record-data/-private')
      ).peekGraph;
      let graph = peekGraph(this);
      if (graph) {
        graph.destroy();
      }
    }

    return super.destroy();
  }

  willDestroy() {
    super.willDestroy();
    this.recordArrayManager.destroy();

    this.identifierCache.destroy();

    // destroy the graph before unloadAll
    // since then we avoid churning relationships
    // during unload
    if (HAS_RECORD_DATA_PACKAGE) {
      const peekGraph = (
        importSync('@ember-data/record-data/-private') as typeof import('@ember-data/record-data/-private')
      ).peekGraph;
      let graph = peekGraph(this);
      if (graph) {
        graph.willDestroy();
      }
    }

    this.unloadAll();

    if (DEBUG) {
      unregisterWaiter(this.__asyncWaiter);
      let tracked = this._trackedAsyncRequests;
      let isSettled = tracked.length === 0;

      if (!isSettled) {
        throw new Error(
          'Async Request leaks detected. Add a breakpoint here and set `store.generateStackTracesForTrackedRequests = true;`to inspect traces for leak origins:\n\t - ' +
            tracked.map((o) => o.label).join('\n\t - ')
        );
      }
    }
  }
}

export default CoreStore;

let assertDestroyingStore: Function;
let assertDestroyedStoreOnly: Function;

if (DEBUG) {
  assertDestroyingStore = function assertDestroyedStore(store, method) {
    assert(
      `Attempted to call store.${method}(), but the store instance has already been destroyed.`,
      !(store.isDestroying || store.isDestroyed)
    );
  };
  assertDestroyedStoreOnly = function assertDestroyedStoreOnly(store, method) {
    assert(
      `Attempted to call store.${method}(), but the store instance has already been destroyed.`,
      !store.isDestroyed
    );
  };
}

/**
 * Flag indicating whether all inverse records are available
 *
 * true if the inverse exists and is loaded (not empty)
 * true if there is no inverse
 * false if the inverse exists and is not loaded (empty)
 *
 * @internal
 * @return {boolean}
 */
function areAllInverseRecordsLoaded(store: CoreStore, resource: JsonApiRelationship): boolean {
  const cache = store.identifierCache;

  if (Array.isArray(resource.data)) {
    // treat as collection
    // check for unloaded records
    let hasEmptyRecords = resource.data.reduce((hasEmptyModel, resourceIdentifier) => {
      return hasEmptyModel || internalModelForRelatedResource(store, cache, resourceIdentifier).isEmpty;
    }, false);

    return !hasEmptyRecords;
  } else {
    // treat as single resource
    if (!resource.data) {
      return true;
    } else {
      const internalModel = internalModelForRelatedResource(store, cache, resource.data);
      return !internalModel.isEmpty;
    }
  }
}

function internalModelForRelatedResource(
  store: CoreStore,
  cache: IdentifierCache,
  resource: ResourceIdentifierObject
): InternalModel {
  const identifier = cache.getOrCreateRecordIdentifier(resource);
  return store._internalModelForResource(identifier);
}

function isMaybeIdentifier(
  maybeIdentifier: string | ResourceIdentifierObject
): maybeIdentifier is ResourceIdentifierObject {
  return Boolean(
    maybeIdentifier !== null &&
      typeof maybeIdentifier === 'object' &&
      (('id' in maybeIdentifier && 'type' in maybeIdentifier && maybeIdentifier.id && maybeIdentifier.type) ||
        maybeIdentifier.lid)
  );
}

function assertIdentifierHasId(
  identifier: StableRecordIdentifier
): asserts identifier is StableExistingRecordIdentifier {
  assert(`Attempted to schedule a fetch for a record without an id.`, identifier.id !== null);
}

function assertRecordsPassedToHasMany(records) {
  assert(`You must pass an array of records to set a hasMany relationship`, Array.isArray(records));
  assert(
    `All elements of a hasMany relationship must be instances of Model, you passed ${records
      .map((r) => `${typeof r}`)
      .join(', ')}`,
    (function () {
      return records.every((record) => Object.prototype.hasOwnProperty.call(record, '_internalModel') === true);
    })()
  );
}

function extractRecordDatasFromRecords(records) {
  return records.map(extractRecordDataFromRecord);
}

function extractRecordDataFromRecord(recordOrPromiseRecord) {
  if (!recordOrPromiseRecord) {
    return null;
  }

  if (recordOrPromiseRecord.then) {
    let content = recordOrPromiseRecord.get && recordOrPromiseRecord.get('content');
    assert(
      'You passed in a promise that did not originate from an EmberData relationship. You can only pass promises that come from a belongsTo or hasMany relationship to the get call.',
      content !== undefined
    );
    return content ? recordDataFor(content) : null;
  }

  return recordDataFor(recordOrPromiseRecord);
}
