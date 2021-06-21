'use strict'

const { patch } = require('../src/eip-1193')
const ethSigUtil = require('eth-sig-util')

// Sign the typed data using the signer's private key. Assumes the provider is
// an instance of `HDWalletProvider`.
const signTypedData = function (provider, params) {
  const [signer, jsonData] = params

  const { privateKey } = provider.wallets[signer.toLowerCase()]
  const data = JSON.parse(jsonData)

  const signature = ethSigUtil.signTypedData(privateKey, { data })

  return Promise.resolve(signature)
}

// Patches the current `HDWalletProvider` so it has a `request` method
// compatible with EIP-1193 and also captures the `eth_signTypedData_v3` method
// so permit messages can be signed with `eth-sig-util`.
//
// See trufflesuite/truffle#3585
const testProvider = function (provider) {
  const _request = patch(provider).request

  provider.request = function ({ method, params }) {
    switch (method) {
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4':
        return signTypedData(provider, params)
      default:
        return _request({ method, params })
    }
  }

  return provider
}

module.exports = testProvider
