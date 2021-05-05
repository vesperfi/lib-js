'use strict'

const { EventEmitter } = require('events')
const Big = require('big.js').default
const debug = require('debug')('vesper-lib:pool')
const erc20Abi = require('erc-20-abi')
const pSeries = require('p-series')
const pTap = require('p-tap')

const { fromUnit, toUnit } = require('./utils')
const createUniswapRouter = require('./uniswap')
const poolRewardsAbi = require('./abi/pool-rewards.json')
const strategyAbi = require('./abi/strategy.json')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const calculateFee = ({ transaction, receipt }) =>
  Big(transaction.gasPrice).times(receipt.gasUsed).toFixed()

const calculateTotalFee = transactionsData =>
  transactionsData
    .map(calculateFee)
    .reduce((total, fee) => Big(total).plus(fee), 0)
    .toFixed()

const findReturnValue = (receipt, eventName, address, prop) =>
  []
    .concat(receipt.events[eventName])
    .filter(event => event.address === address)
    .map(event => event.returnValues[prop])[0]

const createEstimateGasAndSend = (web3, emitter, overestimation = 1.25) =>
  function (tx, transactionOptions, suffix) {
    const suffixed = event => `${event}${suffix ? `-${suffix}` : ''}`

    let hash
    let transactionPromise

    const estimateGas = function () {
      debug('Estimating gas')

      const estimationPromise = tx
        .estimateGas(transactionOptions)
        .then(
          pTap(function (gas) {
            debug('Gas needed is %d (x%s)', gas, overestimation.toFixed(2))
          })
        )
        .then(gas => Math.ceil(gas * overestimation))
        .then(function (gas) {
          // Emit the result
          emitter.emit(suffixed('estimatedGas'), gas)
          return gas
        })

      estimationPromise.catch(function (err) {
        debug('Gas estimation failed: %s', err.message)
        if (!emitter.listenerCount('error')) {
          return
        }
        emitter.emit('error', err)
      })

      return estimationPromise
    }

    const getTransaction = function () {
      if (!transactionPromise) {
        debug('Getting transaction %s', hash)
        transactionPromise = web3.eth.getTransaction(hash)
      }
      return transactionPromise
    }

    // Estimate the gas if not provided and add safety factor
    return Promise.resolve(transactionOptions.gas || estimateGas()).then(
      function (gas) {
        // Send the transaction
        debug(
          'Sending transaction to %s',
          transactionOptions.to || tx._parent.options.address
        )
        const promiEvent = tx.send({ ...transactionOptions, gas })

        // Listen for transaction events
        promiEvent.on('transactionHash', function (_hash) {
          hash = _hash
          debug('Transaction hash is %s', _hash)
          emitter.emit(suffixed('transactionHash'), _hash)
        })
        promiEvent.on('receipt', function (receipt) {
          debug('Transaction %s %s', receipt.status ? 'mined' : 'failed', hash)
          getTransaction()
            .then(function (transaction) {
              emitter.emit(suffixed('receipt'), { transaction, receipt })
            })
            .catch(function (err) {
              promiEvent.emit('error', err)
            })
        })
        promiEvent.on('error', function (err) {
          debug('Transaction failed %s: %s', hash || '?', err.message)
          if (!emitter.listenerCount('error')) {
            return
          }
          emitter.emit('error', err)
        })

        // Return the Web3 PromiEvent that will be casted to Promise
        return promiEvent.then(receipt =>
          getTransaction().then(transaction => ({ transaction, receipt }))
        )
      }
    )
  }

/**
 * Creates the API -methods- to use the pool.
 *
 * @param {object} params The creation params.
 * @param {string} params.address Address of the pool.
 * @param {string} params.asset Name of the deposit asset.
 * @param {Promise} params.contractsPromise The pool and asset contracts.
 * @param {string} [params.from] The default transaction signing address.
 * @param {string} params.name Name of the pool and pool tokens.
 * @param {number} [params.overestimation] The gas over-estimation factor.
 * @param {object} params.tokens The list of known tokens.
 * @param {boolean} params.vspAddress The address of the VSP token contract.
 * @param {boolean} [params.vspRewards] Flag to indicate VSP are granted.
 * @param {object} params.web3 A web3.js instance.
 * @returns {object} Pool methods.
 */
const createPoolMethods = function (params) {
  const {
    address: poolAddress,
    asset,
    contractsPromise,
    from,
    name,
    overestimation,
    tokens,
    vspAddress,
    vspRewards,
    web3
  } = params

  const isToken = asset !== 'ETH'

  const assetDecimals = isToken
    ? tokens.find(t => t.symbol === asset).decimals
    : 18

  // Expected gas per transaction type.
  const expectedGasFor = {
    approval: 66000,
    claimVsp: 100000,
    deposit: 155000,
    rebalance: 825000,
    withdraw: 250000
  }

  // A handy Uniswap router helper.
  const uniswapRouter = createUniswapRouter(web3, vspAddress)

  // Gets the address of the pool.
  const getAddress = () =>
    contractsPromise.then(({ poolContract }) => poolContract.options.address)

  // Gets the address of the deposit asset contract.
  const getAssetAddress = () =>
    isToken
      ? contractsPromise.then(
          ({ assetContract }) => assetContract.options.address
        )
      : Promise.reject(new Error('Pool asset is ETH, not an ERC20 token'))

  // Gets the value of a pool token in deposit assets.
  const getTokenValue = function (defaultBlock) {
    debug('Getting %s token value', name)
    return contractsPromise
      .then(({ poolContract }) =>
        Promise.all([
          poolContract.methods.totalSupply().call({}, defaultBlock),
          poolContract.methods.totalValue().call({}, defaultBlock)
        ])
      )
      .then(([totalSupply, totalValue]) =>
        Big(totalSupply).gt(0)
          ? toUnit(Big(totalValue).div(totalSupply).toFixed())
          : toUnit('1', assetDecimals)
      )
      .then(
        pTap(function (value) {
          debug(
            '%s token value is %s %s',
            name,
            fromUnit(value, assetDecimals),
            asset
          )
        })
      )
  }

  // Gets the address of the strategy contract.
  const getStrategyAddress = function (defaultBlock) {
    debug('Getting %s strategy contract address', name)

    return contractsPromise
      .then(({ controllerContracts: { controller } }) =>
        controller.methods.strategy(poolAddress).call({}, defaultBlock)
      )
      .then(
        pTap(function (strategyAddress) {
          debug('%s strategy contract address is %s', name, strategyAddress)
        })
      )
  }

  // Instantiate a strategy contract.
  const getStrategyContract = function (address) {
    if (address === ZERO_ADDRESS) {
      throw new Error('No strategy contract found')
    }

    return new web3.eth.Contract(strategyAbi, address)
  }

  // Gets the Maker vault info of the strategy (if applicable).
  const getStrategyVaultInfo = function (defaultBlock) {
    debug('Getting %s strategy vault number', name)
    return getStrategyAddress(defaultBlock)
      .then(getStrategyContract)
      .then(strategy =>
        Promise.all([
          strategy.methods.highWater().call({}, defaultBlock),
          strategy.methods.lowWater().call({}, defaultBlock),
          strategy.methods.isUnderwater().call({}, defaultBlock),
          strategy.methods.vaultNum().call({}, defaultBlock),
          contractsPromise
        ])
      )
      .then(
        pTap(function ([, , vaultNum]) {
          debug('%s strategy vault number is %s', name, vaultNum)
        })
      )
      .then(function ([
        highWater,
        lowWater,
        isUnderwater,
        vaultNum,
        {
          controllerContracts: { collateralManager }
        }
      ]) {
        return Promise.all([
          highWater,
          lowWater,
          isUnderwater,
          vaultNum,
          collateralManager.methods
            .getVaultInfo(vaultNum)
            .call({}, defaultBlock)
        ])
      })
      .then(
        ([
          highWater,
          lowWater,
          isUnderwater,
          vaultNum,
          { collateralRatio, daiDebt }
        ]) => ({
          collateralRatio,
          daiDebt,
          highWater,
          isUnderwater,
          lowWater,
          vaultNum
        })
      )
      .catch(function (err) {
        debug('Could not get %s strategy vault number: %s', name, err.message)
        debug('Assuming non-Maker strategy')
        throw err
      })
  }

  // Gets the intereset earned querying the Maker valut and Uniswap.
  const getLegacyInterestEarned = function (defaultBlock) {
    debug('Getting %s interest earned "the legacy way"', name)

    const aDaiAddress = tokens.find(token => token.symbol === 'aDAI').address
    const aDai = new web3.eth.Contract(erc20Abi, aDaiAddress)

    return Promise.all([
      aDai.methods.balanceOf(poolAddress).call({}, defaultBlock),
      getStrategyVaultInfo(defaultBlock)
    ])
      .then(function ([aDaiBalance, { daiDebt }]) {
        const unrealizedDai = Big(aDaiBalance).minus(daiDebt).toFixed()
        debug('%s unrealized gains are %s DAI', name, fromUnit(unrealizedDai))
        return uniswapRouter.getAmountOut(
          unrealizedDai,
          ['DAI', isToken ? asset : 'WETH'],
          defaultBlock
        )
      })
      .then(
        pTap(function () {
          debug('Got %s interest earned by the legacy method', name)
        })
      )
  }

  // Gets the interest earned in deposit asset since the last rebalance.
  const getInterestEarned = function (defaultBlock) {
    debug('Getting %s interest earned', name)
    return getStrategyAddress(defaultBlock)
      .then(getStrategyContract)
      .then(strategy =>
        strategy.methods.interestEarned().call({}, defaultBlock)
      )
      .catch(function (err) {
        debug('Could not get %s interest earned: %s', name, err.message)
        debug('Falling back to legacy method')
        return getLegacyInterestEarned(defaultBlock)
      })
      .catch(function (err) {
        debug('Could not get %s legacy interest earned: %s', name, err.message)
        debug('Assuming %s interest earned is 0.', name)
        return '0'
      })
      .then(function (interestEarned) {
        if (!interestEarned) {
          debug('Could not get %s interest earned: undefined', name)
          debug('Assuming %s interest earned is 0.', name)
          return '0'
        }
        return interestEarned
      })
      .then(
        pTap(function (interestEarned) {
          debug(
            '%s interest earned is %s %s',
            name,
            fromUnit(interestEarned, assetDecimals),
            asset
          )
        })
      )
  }

  // Gets the user's balance of pool tokens.
  const getBalance = function (address, defaultBlock) {
    const _address = address || from
    debug('Getting %s balance of %s', name, _address)

    return contractsPromise
      .then(({ poolContract }) =>
        poolContract.methods.balanceOf(_address).call({}, defaultBlock)
      )
      .then(
        pTap(function (balance) {
          debug('Balance of %s is %s %s', _address, fromUnit(balance), name)
        })
      )
  }

  // Gets the user's balance of deposit assets.
  const getAssetBalance = function (address, defaultBlock) {
    const _address = address || from
    debug('Getting %s balance of %s', asset, _address)

    return (isToken
      ? contractsPromise.then(({ assetContract }) =>
          assetContract.methods.balanceOf(_address).call({}, defaultBlock)
        )
      : web3.eth.getBalance(_address)
    ).then(
      pTap(function (balance) {
        debug(
          'Balance of %s is %s %s',
          _address,
          fromUnit(balance, assetDecimals),
          asset
        )
      })
    )
  }

  // Gets the address of the PoolRewards contract.
  const getPoolRewardsAddress = function (defaultBlock) {
    debug('Getting PoolRewards contract address of %s', name)

    return contractsPromise
      .then(({ controllerContracts: { controller } }) =>
        controller.methods.poolRewards(poolAddress).call({}, defaultBlock)
      )
      .then(
        pTap(function (address) {
          debug('PoolRewards contract address of %s is %s', name, address)
        })
      )
  }

  // Instantiate a PoolRewards contract.
  const getPoolRewardsContract = function (address) {
    if (address === ZERO_ADDRESS) {
      throw new Error('No rewards contract found')
    }

    return new web3.eth.Contract(poolRewardsAbi, address)
  }

  // Gets the balance of claimable VSP.
  const getClaimableVsp = function (address, defaultBlock) {
    const _address = address || from
    debug('Getting claimable rewards of %s', _address)

    return getPoolRewardsAddress()
      .then(getPoolRewardsContract)
      .then(poolRewards =>
        Promise.all([
          poolRewards.methods.claimable(_address).call({}, defaultBlock),
          poolRewards.methods.rewardToken().call({}, defaultBlock)
        ])
      )
      .then(([balance, token]) => (token === vspAddress ? balance : '0'))
      .then(
        pTap(function (balance) {
          debug(
            'Claimable rewards of %s in %s is %s VSP',
            _address,
            name,
            fromUnit(balance)
          )
        })
      )
      .catch(function (err) {
        debug('Could not get claimable rewards in %s: %s', name, err.message)
        debug('Assuming claimable rewards in %s is 0 VSP', name)
        return '0'
      })
  }

  // Gets the user's balance of pool tokens in deposit asset.
  const getDepositedBalance = function (address) {
    const _address = address || from
    debug('Getting deposited %s amount', asset)

    return Promise.all([getBalance(_address), getTokenValue()])
      .then(([balance, value]) =>
        Big(fromUnit(Big(balance).times(value).toFixed())).toFixed(0)
      )
      .then(
        pTap(function (balance) {
          debug(
            'Balance of %s is %s %s',
            _address,
            fromUnit(balance, assetDecimals),
            asset
          )
        })
      )
  }

  // Gets the total supply of pool tokens.
  const getTotalSupply = function (defaultBlock) {
    debug('Getting %s total supply', name)

    return contractsPromise
      .then(({ poolContract }) =>
        poolContract.methods.totalSupply().call({}, defaultBlock)
      )
      .then(
        pTap(function (totalSupply) {
          debug('%s total supply is %s', name, fromUnit(totalSupply))
        })
      )
  }

  // Gets the withdraw fee.
  const getWithdrawFee = function (defaultBlock) {
    debug('Getting %s withdraw fee', name)

    return contractsPromise
      .then(({ poolContract }) =>
        poolContract.methods.withdrawFee().call({}, defaultBlock)
      )
      .then(withdrawFee => Big(fromUnit(withdrawFee)).toNumber())
      .then(
        pTap(function (withdrawFee) {
          debug('%s withdraw fee is %s%', name, withdrawFee * 100)
        })
      )
  }

  // Gets the interes fee.
  const getInterestFee = function (defaultBlock) {
    debug('Getting %s interest fee', name)

    return contractsPromise
      .then(({ controllerContracts: { controller } }) =>
        controller.methods.interestFee(poolAddress).call({}, defaultBlock)
      )
      .then(interestFee => Big(fromUnit(interestFee)).toNumber())
      .then(
        pTap(function (interestFee) {
          debug('%s interest fee is %s%', name, interestFee * 100)
        })
      )
  }

  // Checks if the pool can be rebalanced.
  // TODO For MakerDAO strategies: tokens (in USD) / high water (3) >= 100 USD
  const canRebalance = (address, defaultBlock) =>
    contractsPromise
      .then(({ poolContract }) =>
        Promise.all([
          poolContract,
          poolContract.methods.tokensHere().call({}, defaultBlock)
        ])
      )
      .then(
        pTap(function ([, amount]) {
          debug(
            '%s pool has %s %s',
            name,
            fromUnit(amount, assetDecimals),
            name
          )
        })
      )
      .then(([poolContract, amount]) => [poolContract, Big(amount).gt(0)])
      .then(function ([poolContract, _canRebalance]) {
        if (!_canRebalance) {
          return false
        }
        debug('Testing rebalance call by estimating gas')
        return poolContract.methods
          .rebalance()
          .estimateGas({ from: address || from })
          .catch(function (err) {
            debug('Rebalance gas etimation failed: %s', err.message)
            return false
          })
      })
      .then(
        pTap(function (_canRebalance) {
          debug(
            '%s pool %s be rebalanced',
            name,
            _canRebalance ? 'can' : 'cannot'
          )
        })
      )

  // Checks if the pool grants VSP rewards.
  const hasVspRewards = function (defaultBlock) {
    debug('Checking if %s grants VSP rewards', name)

    return Promise.resolve(
      vspRewards ||
        getPoolRewardsAddress(defaultBlock).then(
          address =>
            address !== ZERO_ADDRESS &&
            getPoolRewardsContract(address)
              .methods.rewardToken()
              .call({}, defaultBlock)
              .then(token => token === vspAddress)
        )
    ).then(
      pTap(function (flag) {
        debug('%s %sgrants VSP rewards', name, flag ? '' : 'does not ')
      })
    )
  }

  // Gets the VSP rewards rate in VSP/sec.
  const getVspRewardsRate = function (defaultBlock) {
    debug('Getting %s rewards rate', name)

    return getPoolRewardsAddress(defaultBlock)
      .then(getPoolRewardsContract)
      .then(poolRewards =>
        Promise.all([
          poolRewards.methods.rewardRate().call({}, defaultBlock),
          poolRewards.methods.rewardToken().call({}, defaultBlock)
        ])
      )
      .then(([rate, token]) => (token === vspAddress ? rate : '0'))
      .catch(function (err) {
        debug('Could not get %s rewards rate:', err.message)
        return '0'
      })
      .then(
        pTap(function (rate) {
          debug('%s rewards rate is %s VSP/s', name, fromUnit(rate))
        })
      )
  }

  // Gets the value locked in the pool in USDC.
  const getValueLocked = function (defaultBlock) {
    debug('Getting %s value locked', name)

    return contractsPromise
      .then(({ poolContract }) =>
        poolContract.methods.totalValue().call({}, defaultBlock)
      )
      .then(function (totalValue) {
        const oneAsset = Big(10).pow(Number.parseInt(assetDecimals)).toFixed(0)
        return Promise.all([
          totalValue,
          asset === 'USDC'
            ? oneAsset
            : uniswapRouter.getAmountOut(
                oneAsset,
                isToken
                  ? asset === 'VSP'
                    ? ['VSP', 'WETH', 'USDC']
                    : [asset, 'USDC']
                  : ['WETH', 'USDC'],
                defaultBlock
              ),
          oneAsset
        ])
      })
      .then(([totalValue, rate, oneAsset]) =>
        Big(totalValue).mul(rate).div(oneAsset).toFixed(0)
      )
      .then(
        pTap(function (valueLocked) {
          debug('%s value locked is %s USDC', name, fromUnit(valueLocked, 6))
        })
      )
  }

  // Gets the time when the withdraw lock will expire in ms or 0 if unlocked.
  // This is only applicable to the vVSP pool.
  const getWithdrawTimelock = function (address) {
    if (name !== 'vVSP') {
      return Promise.resolve(0)
    }

    debug('Getting vVSP withdraw timelock status')

    return contractsPromise
      .then(({ poolContract }) =>
        Promise.all([
          poolContract.methods
            .depositTimestamp(address)
            .call()
            .then(Number.parseInt),
          poolContract.methods.lockPeriod().call().then(Number.parseInt)
        ])
      )
      .then(function ([depositTimestamp, lockPeriod]) {
        if (!depositTimestamp) {
          return 0
        }
        const unlockTime = (depositTimestamp + lockPeriod) * 1000
        return unlockTime > Date.now() ? unlockTime : 0
      })
      .then(
        pTap(function (timelockExpiration) {
          debug(
            'vVSP withdraw is %s',
            timelockExpiration
              ? `locked until ${new Date(timelockExpiration).toISOString()}`
              : 'unlocked'
          )
        })
      )
  }

  // Deposits assets in the pool.
  const deposit = function (amount, transactionOptions = {}) {
    const _from = transactionOptions.from || from

    const emitter = new EventEmitter()
    const estimateGasAndSend = createEstimateGasAndSend(
      web3,
      emitter,
      overestimation
    )

    const promise = contractsPromise
      .then(({ assetContract, poolContract }) =>
        Promise.all([
          poolContract,
          assetContract,
          web3.eth.getGasPrice(),
          web3.eth.getTransactionCount(_from, 'pending'),
          isToken
            ? assetContract.methods
                .allowance(_from, poolContract.options.address)
                .call()
            : amount
        ])
      )
      .then(function ([
        poolContract,
        assetContract,
        gasPrice,
        count,
        remaining
      ]) {
        debug(
          'Initiating deposit of %s %s into %s',
          fromUnit(amount, assetDecimals),
          asset,
          name
        )
        debug(
          'Allowance remaining is %s %s',
          fromUnit(remaining, assetDecimals),
          asset
        )

        const txs = []
        let expectedGas = 0
        if (Big(remaining).lt(amount)) {
          txs.push({
            method: assetContract.methods.approve(
              poolContract.options.address,
              amount
            ),
            suffix: 'approve'
          })
          expectedGas += expectedGasFor.approval
        }
        txs.push({
          method: isToken
            ? poolContract.methods.deposit(amount)
            : poolContract.methods.deposit(),
          value: isToken ? '0' : amount,
          suffix: 'deposit'
        })
        expectedGas += expectedGasFor.deposit

        const expectedFee = Big(gasPrice).times(expectedGas).toFixed()
        debug(
          'Expected fee in %d transaction(s) is %s ETH',
          txs.length,
          fromUnit(expectedFee)
        )
        emitter.emit('transactions', {
          expectedFee,
          suffixes: txs.map(({ suffix }) => suffix)
        })

        debug(
          'Sending %s transaction(s): %s',
          txs.length,
          txs.map(tx => tx.suffix).join(', ')
        )
        return Promise.all([
          poolContract,
          pSeries(
            txs.map(({ method, suffix, value }, i) => () =>
              estimateGasAndSend(
                method,
                { from, ...transactionOptions, value, nonce: count + i },
                suffix
              )
            )
          )
        ])
      })
      .then(function ([poolContract, transactionsData]) {
        const result = {
          sent: amount,
          fees: calculateTotalFee(transactionsData),
          received:
            findReturnValue(
              transactionsData[transactionsData.length - 1].receipt,
              'Transfer',
              poolContract.options.address,
              'value'
            ) || '0',
          decimals: '18',
          raw: transactionsData,
          status: transactionsData[transactionsData.length - 1].receipt.status
        }

        debug(
          'Deposit of %s %s completed',
          fromUnit(amount, assetDecimals),
          asset
        )
        debug('Received %s %s', fromUnit(result.received), name)
        debug('Total transaction fees paid %s ETH', fromUnit(result.fees))
        emitter.emit('result', result)
        return result
      })

    promise.catch(function (err) {
      if (emitter.listenerCount('error')) {
        return
      }
      throw err
    })

    return {
      emitter,
      promise
    }
  }

  // Withdraws deposit assets from the pool.
  const withdraw = function (amount, transactionOptions = {}) {
    const emitter = new EventEmitter()
    const estimateGasAndSend = createEstimateGasAndSend(
      web3,
      emitter,
      overestimation
    )

    const promise = contractsPromise
      .then(({ poolContract }) =>
        Promise.all([poolContract, web3.eth.getGasPrice(), getTokenValue()])
      )
      .then(function ([poolContract, gasPrice, tokenValue]) {
        debug(
          'Initiating withdrawal of %s %s',
          fromUnit(amount, assetDecimals),
          asset
        )

        const tokenAmount = toUnit(Big(amount).div(tokenValue).toFixed())
        debug('Sending %s %s', fromUnit(tokenAmount), name)

        const expectedFee = Big(gasPrice)
          .times(expectedGasFor.withdraw)
          .toFixed()
        debug('Expected fee in 1 transaction is %d ETH', fromUnit(expectedFee))
        emitter.emit('transactions', {
          expectedFee,
          suffixes: ['withdraw']
        })

        return Promise.all([
          poolContract,
          tokenAmount,
          estimateGasAndSend(
            isToken
              ? poolContract.methods.withdraw(tokenAmount)
              : poolContract.methods.withdrawETH(tokenAmount),
            { from, ...transactionOptions },
            'withdraw'
          )
        ])
      })
      .then(function ([poolContract, tokenAmount, transactionData]) {
        const result = {
          sent: tokenAmount,
          fees: calculateFee(transactionData),
          received:
            findReturnValue(
              transactionData.receipt,
              'Withdraw',
              poolContract.options.address,
              'amount'
            ) || '0',
          decimals: assetDecimals,
          raw: [transactionData],
          status: transactionData.receipt.status
        }

        debug(
          'Withdrawal of %s %s completed',
          fromUnit(amount, assetDecimals),
          asset
        )
        debug('Received %s %s', fromUnit(result.received, assetDecimals), asset)
        debug('Total transaction fees paid %s ETH', fromUnit(result.fees))
        emitter.emit('result', result)
        return result
      })

    promise.catch(function (err) {
      if (emitter.listenerCount('error')) {
        return
      }
      throw err
    })

    return {
      emitter,
      promise
    }
  }

  // Claims all claimable VSP in the pool.
  const claimVsp = function (transactionOptions = {}) {
    const emitter = new EventEmitter()
    const estimateGasAndSend = createEstimateGasAndSend(
      web3,
      emitter,
      overestimation
    )

    const promise = Promise.all([
      getPoolRewardsAddress().then(getPoolRewardsContract),
      web3.eth.getGasPrice(),
      getClaimableVsp(from)
    ])
      .then(function ([poolRewardsContract, gasPrice, amount]) {
        debug('Initiating claim of %s VSP', fromUnit(amount))

        const expectedFee = Big(gasPrice)
          .times(expectedGasFor.claimVsp)
          .toFixed()
        debug('Expected fee in 1 transaction is %d ETH', fromUnit(expectedFee))
        emitter.emit('transactions', {
          expectedFee,
          suffixes: ['claim']
        })

        return Promise.all([
          poolRewardsContract,
          estimateGasAndSend(
            poolRewardsContract.methods.claimReward(from),
            { from, ...transactionOptions },
            'claim'
          )
        ])
      })
      .then(function ([poolRewardsContract, transactionData]) {
        const result = {
          fees: calculateFee(transactionData),
          received:
            findReturnValue(
              transactionData.receipt,
              'RewardPaid',
              poolRewardsContract.options.address,
              'reward'
            ) || '0',
          raw: [transactionData],
          status: transactionData.receipt.status
        }

        debug('Claim of %s VSP completed', fromUnit(result.received))
        debug('Total fees paid %s ETH', fromUnit(result.fees))
        emitter.emit('result', result)
        return result
      })

    promise.catch(function (err) {
      if (emitter.listenerCount('error')) {
        return
      }
      throw err
    })

    return {
      emitter,
      promise
    }
  }

  // Rebalances the pool.
  const rebalance = function (transactionOptions = {}) {
    const emitter = new EventEmitter()
    const estimateGasAndSend = createEstimateGasAndSend(
      web3,
      emitter,
      overestimation
    )

    const promise = contractsPromise
      .then(({ poolContract }) =>
        Promise.all([poolContract, web3.eth.getGasPrice()])
      )
      .then(function ([poolContract, gasPrice]) {
        debug('Initiating rebalance of %s', name)

        const expectedFee = Big(gasPrice)
          .times(expectedGasFor.rebalance)
          .toFixed()
        debug('Expected fee in 1 transaction is %d ETH', fromUnit(expectedFee))
        emitter.emit('transactions', {
          expectedFee,
          suffixes: ['rebalance']
        })

        return estimateGasAndSend(
          poolContract.methods.rebalance(),
          { from, ...transactionOptions },
          'rebalance'
        )
      })
      .then(function (transactionData) {
        const result = {
          fees: calculateFee(transactionData),
          raw: [transactionData],
          status: transactionData.receipt.status
        }

        debug('Rebalance of %s completed', name)
        debug('Total transaction fees paid %s ETH', fromUnit(result.fees))
        emitter.emit('result', result)
        return result
      })

    promise.catch(function (err) {
      if (emitter.listenerCount('error')) {
        return
      }
      throw err
    })

    return {
      emitter,
      promise
    }
  }

  // Return the pool contracts
  const getContracts = () => contractsPromise

  return {
    canRebalance,
    claimVsp,
    deposit,
    getAddress,
    getAssetAddress,
    getAssetBalance,
    getBalance,
    getClaimableVsp,
    getContracts,
    getDepositedBalance,
    getInterestEarned,
    getInterestFee,
    getPoolRewardsAddress,
    getVspRewardsRate,
    getStrategyAddress,
    getStrategyVaultInfo,
    getTokenValue,
    getTotalSupply,
    getValueLocked,
    getWithdrawFee,
    getWithdrawTimelock,
    hasVspRewards,
    rebalance,
    withdraw
  }
}

module.exports = createPoolMethods
