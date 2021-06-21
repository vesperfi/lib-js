'use strict'

/**
 * Repeately calls the iterator function until an error is found.
 *
 * The iterator function is called with the iteration number as a single
 * parameter, starting with 0. To stop the loop, the function must either throw
 * or return a rejected promise. The result is an array with the results of all
 * the iterator calls.
 *
 * @param {Function} fn The iterator function.
 * @returns {Promise<Array>} The results array.
 */
function promiseLoop(fn) {
  const step = function (acc, i) {
    return Promise.resolve(fn(i))
      .then(res => step(acc.concat(res), i + 1))
      .catch(() => acc)
  }
  return step([], 0)
}

module.exports = promiseLoop
