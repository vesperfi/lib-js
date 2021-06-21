'use strict'

const { promisify } = require('util')

// Patches an Ethereum provider so it has a `request` method as specified by
// EIP-1193.
const patch = function (provider) {
  // If the request method is present, do nothing.
  if (typeof provider.request === 'function') {
    return provider
  }

  // Otherwise, test if the legacy methods exist.
  const sendAsync = provider.sendAsync || provider.send
  if (!sendAsync || typeof sendAsync !== 'function') {
    throw new Error('Provider does not have a sendAsync or send method to use')
  }

  // And then patch the provider. The legacy methods receive a JSON-RPC request
  // and a callback, and return a JSON-RPC response. Wrap and un-wrap is needed.
  const sendJsonRpc = promisify(sendAsync.bind(provider))
  provider.request = function ({ method, params }) {
    const id = Date.now()
    const payload = { id, jsonrpc: '2.0', method, params }
    return sendJsonRpc(payload).then(function (response) {
      if (response.jsonrpc !== '2.0' || response.id !== id) {
        throw new Error('Invalid JSON-RPC response')
      }
      if (response.error) {
        throw new Error(response.error)
      }
      return response.result
    })
  }

  return provider
}

module.exports = { patch }
