'use strict'

require('dotenv').config()
require('chai').should()
const Web3 = require('web3')

const createVesper = require('..')

describe('E2E', function () {
  this.timeout(0)

  let web3

  before(function () {
    if (!process.env.E2E) {
      this.skip()
      return
    }

    web3 = new Web3(process.env.NODE_URL || 'http://127.0.0.1:8545')
  })

  describe('Pools information', function () {
    it('should get the pools information', function () {
      const vesper = createVesper(web3, { stages: ['-retired'] })
      return vesper.getPools().then(function (pools) {
        pools.should.be.an('array')
        pools.forEach(function (pool) {
          pool.should.include.all.keys(
            'address',
            'asset',
            'birthblock',
            'decimals',
            'interestEarned',
            'name',
            'riskLevel',
            'stage',
            'status',
            'tokenValue',
            'totalSupply',
            'totalValue',
            'withdrawFee'
          )
          pool.should.have
            .property('address')
            .that.is.a('string')
            .that.matches(/^0x[0-9a-fA-F]{40}$/)
          pool.should.have.property('asset').that.is.a('object')
          pool.should.have.nested.property('asset.symbol').that.is.a('string')
          if (pool.asset.symbol !== 'ETH') {
            pool.should.have.nested
              .property('asset.address')
              .that.is.a('string')
              .that.matches(/^0x[0-9a-fA-F]{40}$/)
          } else {
            pool.should.have.nested.property('asset.address').that.is.null
          }
          pool.should.have.nested
            .property('asset.decimals')
            .that.is.a('string')
            .that.matches(/^[0-9]*$/)
          pool.should.have.property('birthblock').that.is.a('number')
          pool.should.have
            .property('decimals')
            .that.is.a('string')
            .that.matches(/^[0-9]*$/)
          pool.should.have
            .property('interestEarned')
            .that.is.a('string')
            .that.matches(/^[0-9]*$/)
          pool.should.have.property('name').that.is.a('string')
          pool.should.have
            .property('riskLevel')
            .that.is.a('number')
            .that.is.within(1, 5)
          pool.should.have.property('stage').that.is.a('string')
          pool.should.have.property('status').that.is.a('string')
          pool.should.have
            .property('tokenValue')
            .that.is.a('string')
            .that.matches(/^[0-9]*$/)
          pool.should.have
            .property('totalSupply')
            .that.is.a('string')
            .that.matches(/^[0-9]*$/)
          pool.should.have
            .property('totalValue')
            .that.is.a('string')
            .that.matches(/^[0-9]*$/)
          pool.should.have
            .property('withdrawFee')
            .that.is.a('number')
            .that.is.within(0, 1)
        })
      })
    })
  })
})
