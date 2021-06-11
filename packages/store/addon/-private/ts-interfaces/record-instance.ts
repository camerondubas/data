type Dict<T> = import('./utils').Dict<T>;
/**
  @module @ember-data/store
*/
type DSModel = import('./ds-model').DSModel;
/*
  A `Record` is the result of the store instantiating a class to present data for a resource to the UI.

  Historically in `ember-data` this meant that it was the result of calling `_modelFactoryFor.create()` to
  gain instance to a class built upon `@ember-data/model`. However, as we go forward into a future in which
  model instances (aka `Records`) are completely user supplied and opaque to the internals, we need a type
  through which to communicate what is valid.

  The type belows allows for anything extending object.
*/

//export type RecordInstance = DSModel | Dict<unknown>;
export type RecordInstance = object;
