'use strict'

require('chai').should()

const { utils } = require('../src/index')

describe('Utils', function () {
  it('should convert to unit', function () {
    utils.toUnit('1.23', 8).should.equal('123000000')
    utils.toUnit('50000', 18).should.equal('50000000000000000000000')
  })

  it('should convert from unit', function () {
    utils.fromUnit('123000000', 8).should.equal('1.23')
    utils.fromUnit('50000000000000000000000', 18).should.equal('50000')
  })
})
