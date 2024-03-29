import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

import {
  deployGnosisSafeSingleton,
  deployGnosisSafeFactory,
  deployGnosisSafe,
  deployRegistryModuleSingleton,
  deployModuleProxyFactory,
  deployRegistryModule,
  enableModule,
  setupRegistry,
  sendArbitraryTx,
} from "../mixins";

import {
  AccountingModule,
  RegistryModule,
  MockToken,
  GnosisSafeL2,
  LifecycleModule,
  StakingModule,
} from "../../typechain";

import {
  getCurrentTimestamp,
  timeTravel,
  takeSnapshot,
  restoreSnapshot,
} from "../utils";

// Lifecycle module params
const EPOCH_LENGTH = 3600 * 24 * 7; // 1 week
const STAKING_LENGTH = 3600 * 4; // 4 hours
const TRADING_LENGTH = 3600 * 24 * 2; // 2 days

// Accounting module params
const YEAR_SECONDS = 360 * 24 * 3600; // 1 year in seconds
const BASE = ethers.utils.parseEther("1");
const PROFIT_FEE = ethers.utils.parseEther("0.1");
const ANNUAL_MAINTENANCE_FEE = ethers.utils.parseEther("0.02");

// Contacts for tests
const DEPOSIT_AMOUNT = ethers.utils.parseEther("200");
const WITHDRAWAL_AMOUNT = ethers.utils.parseEther("100");
const UTILIZED_AMOUNT = ethers.utils.parseEther("20");
const PREMIUM_AMOUNT = ethers.utils.parseEther("10");

const TOTAL_DEPOSITED_AMOUNT = DEPOSIT_AMOUNT.sub(WITHDRAWAL_AMOUNT); // 100

const TOTAL_AVAILABLE_AMOUNT =
  TOTAL_DEPOSITED_AMOUNT.add(PREMIUM_AMOUNT).sub(UTILIZED_AMOUNT); // 90

const TOTAL_UTILIZED_AMOUNT = UTILIZED_AMOUNT.sub(PREMIUM_AMOUNT); // 10
const TOTAL_UTILIZED_RATIO = TOTAL_UTILIZED_AMOUNT.mul(BASE).div(
  TOTAL_DEPOSITED_AMOUNT
); // 0.1

const PROFIT_FEE_AMOUNT = PREMIUM_AMOUNT.mul(PROFIT_FEE).div(BASE); // 1
const MAINTENANCE_FEE_AMOUNT = TOTAL_DEPOSITED_AMOUNT.mul(
  ANNUAL_MAINTENANCE_FEE
)
  .mul(EPOCH_LENGTH)
  .div(YEAR_SECONDS)
  .div(BASE); // 0.03(8)

const FINAL_LIQUIDITY_AMOUNT = TOTAL_DEPOSITED_AMOUNT.add(PREMIUM_AMOUNT)
  .sub(PROFIT_FEE_AMOUNT)
  .sub(MAINTENANCE_FEE_AMOUNT); // 109.86(1)

const TOTAL_FEES_AMOUNT = PROFIT_FEE_AMOUNT.add(MAINTENANCE_FEE_AMOUNT); // 1.03(8)

// Gnosis Safe Utils
const GNOSIS_SAFE_FALLBACK_HANDLER =
  "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4";

describe("AccountingModule", function () {
  let accountingModule: AccountingModule;
  let registryModule: RegistryModule;
  let lifecycleModule: LifecycleModule;
  let stakingModule: StakingModule;

  let deployer: SignerWithAddress;
  let feeCollectorSigner: SignerWithAddress;
  let strategyModule: SignerWithAddress;

  let gnosisSafe: GnosisSafeL2;

  let mockToken: MockToken;
  let mockPosition: MockToken;

  let snapshotId: any;

  before(async () => {
    snapshotId = await takeSnapshot();

    [deployer, feeCollectorSigner, strategyModule] = await ethers.getSigners();

    // Deploy mocks
    const MockToken = await ethers.getContractFactory("MockToken");
    mockToken = (await MockToken.deploy()) as MockToken;
    await mockToken.deployed();
    await mockToken.transfer(strategyModule.address, PREMIUM_AMOUNT);

    mockPosition = (await MockToken.deploy()) as MockToken;
    await mockPosition.deployed();

    // Setup GnosisSafe
    const gnosisSafeSingleton = await deployGnosisSafeSingleton();
    const gnosisSafeProxyFactory = await deployGnosisSafeFactory();
    gnosisSafe = await deployGnosisSafe(
      gnosisSafeSingleton,
      gnosisSafeProxyFactory,
      GNOSIS_SAFE_FALLBACK_HANDLER,
      deployer
    );

    // Deploy Registry Module
    const registryModuleSingleton = await deployRegistryModuleSingleton();
    const moduleProxyFactory = await deployModuleProxyFactory();
    registryModule = await deployRegistryModule(
      registryModuleSingleton,
      moduleProxyFactory,
      gnosisSafe.address
    );

    // Deploy Accounting Module
    const AccountingModule = await ethers.getContractFactory(
      "AccountingModule"
    );
    accountingModule = <AccountingModule>(
      await upgrades.deployProxy(AccountingModule, [
        mockToken.address,
        registryModule.address,
        gnosisSafe.address,
      ])
    );
    await accountingModule.deployed();

    // Deploy Lifecycle Module
    const now = await getCurrentTimestamp();
    const currentEpochStart = now - STAKING_LENGTH / 2;

    const LifecycleModule = await ethers.getContractFactory("LifecycleModule");
    lifecycleModule = <LifecycleModule>(
      await upgrades.deployProxy(LifecycleModule, [
        currentEpochStart,
        [EPOCH_LENGTH, STAKING_LENGTH, TRADING_LENGTH],
        registryModule.address,
        deployer.address,
      ])
    );
    await lifecycleModule.deployed();

    // Deploy Staking Module
    const StakingModule = await ethers.getContractFactory("StakingModule");
    stakingModule = <StakingModule>(
      await upgrades.deployProxy(StakingModule, [
        "LP Token",
        "LPT",
        registryModule.address,
        gnosisSafe.address,
      ])
    );
    await stakingModule.deployed();

    // Additional setup
    await setupRegistry(
      gnosisSafe,
      registryModule,
      accountingModule,
      lifecycleModule,
      stakingModule,
      strategyModule.address,
      deployer
    );

    await enableModule(gnosisSafe, registryModule.address, deployer);
  });

  after(async () => {
    await restoreSnapshot(snapshotId);
  });

  it("should correctly return initial values", async function () {
    const underlying = await accountingModule.getUnderlying();
    expect(underlying).to.be.equal(mockToken.address);

    const totalLiquidity = await accountingModule.getTotalLiquidity();
    expect(totalLiquidity).to.be.equal(0);

    const utilizedLiquidity = await accountingModule.getUtilizedLiquidity();
    expect(utilizedLiquidity).to.be.equal(0);

    const availableLiquidity = await accountingModule.getAvailableLiquidity();
    expect(availableLiquidity).to.be.equal(0);

    const liquidityUtilizationRatio =
      await accountingModule.getLiquidityUtilizationRatio();
    expect(liquidityUtilizationRatio).to.be.equal(0);

    const accumulatedFees = await accountingModule.getAccumulatedFees();
    expect(accumulatedFees).to.be.equal(0);

    const hasPosition = await accountingModule.hasPosition(
      mockPosition.address
    );
    expect(hasPosition).to.be.equal(false);

    const feeCollector = await accountingModule.getFeeCollector();
    expect(feeCollector).to.be.equal(ethers.constants.AddressZero);

    const immediateProfitFee = await accountingModule.getImmediateProfitFee();
    expect(immediateProfitFee).to.be.equal(PROFIT_FEE);

    const annualMaintenanceFee =
      await accountingModule.getAnnualMaintenanceFee();
    expect(annualMaintenanceFee).to.be.equal(ANNUAL_MAINTENANCE_FEE);

    const benchmarkProfit = await accountingModule.getBenchmarkProfit();
    expect(benchmarkProfit).to.be.equal(0);
  });

  it("should revert on unauthorized access", async function () {
    await expect(
      accountingModule
        .connect(deployer)
        .changeTotalLiquidity(DEPOSIT_AMOUNT, true)
    ).to.be.revertedWith("AM1");

    await expect(
      accountingModule
        .connect(deployer)
        .changeHoldingPosition(mockPosition.address, true)
    ).to.be.revertedWith("AM2");

    await expect(
      accountingModule.connect(deployer).rebalance()
    ).to.be.revertedWith("AM2");

    await expect(
      accountingModule.connect(deployer).collectFees()
    ).to.be.revertedWith("AM4");

    await expect(
      accountingModule
        .connect(feeCollectorSigner)
        .setFeeCollector(feeCollectorSigner.address)
    ).to.be.revertedWith("AM6");
  });

  it("should correctly add / remove liquidity with staking module", async function () {
    await mockToken.approve(stakingModule.address, DEPOSIT_AMOUNT);
    await stakingModule.deposit(DEPOSIT_AMOUNT, deployer.address);

    const totalLiquidityBefore = await accountingModule.getTotalLiquidity();
    expect(totalLiquidityBefore).to.be.equal(DEPOSIT_AMOUNT);

    await stakingModule.withdraw(
      WITHDRAWAL_AMOUNT,
      deployer.address,
      deployer.address
    );

    const totalLiquidityAfter = await accountingModule.getTotalLiquidity();
    expect(totalLiquidityAfter).to.be.equal(TOTAL_DEPOSITED_AMOUNT);

    const availableLiquidity = await accountingModule.getAvailableLiquidity();
    expect(availableLiquidity).to.be.equal(TOTAL_DEPOSITED_AMOUNT);
  });

  it("should correctly utilize liquidity with strategy module", async function () {
    await sendArbitraryTx(
      gnosisSafe,
      mockToken.address,
      mockToken.interface.encodeFunctionData("transfer", [
        strategyModule.address,
        UTILIZED_AMOUNT,
      ]),
      deployer
    );
    await mockToken
      .connect(strategyModule)
      .transfer(gnosisSafe.address, PREMIUM_AMOUNT);

    await accountingModule
      .connect(strategyModule)
      .changeHoldingPosition(mockPosition.address, true);

    const hasPosition = await accountingModule.hasPosition(
      mockPosition.address
    );
    expect(hasPosition).to.be.equal(true);

    const availableLiquidity = await accountingModule.getAvailableLiquidity();
    expect(availableLiquidity).to.be.equal(TOTAL_AVAILABLE_AMOUNT);

    const utilizedLiquidity = await accountingModule.getUtilizedLiquidity();
    expect(utilizedLiquidity).to.be.equal(TOTAL_UTILIZED_AMOUNT);

    const liquidityUtilizationRatio =
      await accountingModule.getLiquidityUtilizationRatio();
    expect(liquidityUtilizationRatio).to.be.equal(TOTAL_UTILIZED_RATIO);
  });

  it("should correctly return liquidity by the strategy module", async function () {
    await mockToken
      .connect(strategyModule)
      .transfer(gnosisSafe.address, UTILIZED_AMOUNT);

    await accountingModule
      .connect(strategyModule)
      .changeHoldingPosition(mockPosition.address, false);

    const hasPosition = await accountingModule.hasPosition(
      mockPosition.address
    );
    expect(hasPosition).to.be.equal(false);

    const availableLiquidity = await accountingModule.getAvailableLiquidity();
    expect(availableLiquidity).to.be.equal(
      TOTAL_DEPOSITED_AMOUNT.add(PREMIUM_AMOUNT)
    );

    const utilizedLiquidity = await accountingModule.getUtilizedLiquidity();
    expect(utilizedLiquidity).to.be.equal("0");

    const liquidityUtilizationRatio =
      await accountingModule.getLiquidityUtilizationRatio();
    expect(liquidityUtilizationRatio).to.be.equal("0");
  });

  it("should correctly rebalance and progress epoch", async function () {
    await timeTravel(EPOCH_LENGTH);

    await accountingModule.connect(strategyModule).rebalance();

    const totalLiquidity = await accountingModule.getTotalLiquidity();
    expect(totalLiquidity).to.be.equal(FINAL_LIQUIDITY_AMOUNT);

    const utilizedLiquidity = await accountingModule.getUtilizedLiquidity();
    expect(utilizedLiquidity).to.be.equal(0);

    const availableLiquidity = await accountingModule.getAvailableLiquidity();
    expect(availableLiquidity).to.be.equal(FINAL_LIQUIDITY_AMOUNT);

    const liquidityUtilizationRatio =
      await accountingModule.getLiquidityUtilizationRatio();
    expect(liquidityUtilizationRatio).to.be.equal(0);

    const accumulatedFees = await accountingModule.getAccumulatedFees();
    expect(accumulatedFees).to.be.equal(TOTAL_FEES_AMOUNT);
  });

  it("should correctly set fee collector", async () => {
    await sendArbitraryTx(
      gnosisSafe,
      accountingModule.address,
      accountingModule.interface.encodeFunctionData("setFeeCollector", [
        feeCollectorSigner.address,
      ]),
      deployer
    );

    const feeCollector = await accountingModule.getFeeCollector();
    expect(feeCollector).to.be.equal(feeCollectorSigner.address);
  });

  it("should send fees to fee collector on demand", async () => {
    await accountingModule.connect(feeCollectorSigner).collectFees();

    const feeCollectorBalance = await mockToken.balanceOf(
      feeCollectorSigner.address
    );
    expect(feeCollectorBalance).to.be.equal(TOTAL_FEES_AMOUNT);

    const accumulatedFees = await accountingModule.getAccumulatedFees();
    expect(accumulatedFees).to.be.equal("0");
  });

  it("should correctly set benchmark profit and revert unauthorized access", async () => {
    const newBenchmarkProfit = ethers.utils.parseEther("0.05");

    // Test revert
    await expect(
      accountingModule
        .connect(feeCollectorSigner)
        .setBenchmarkProfit(newBenchmarkProfit)
    ).to.be.revertedWith("Ownable: caller is not the owner");

    // Test correct set
    await sendArbitraryTx(
      gnosisSafe,
      accountingModule.address,
      accountingModule.interface.encodeFunctionData("setBenchmarkProfit", [
        newBenchmarkProfit,
      ]),
      deployer
    );
    const benchmarkProfit = await accountingModule.getBenchmarkProfit();
    expect(benchmarkProfit).to.be.equal(newBenchmarkProfit);

    // Test calculation of Rage Quit fees
    const maintenanceFeePerEpoch =
      ANNUAL_MAINTENANCE_FEE.mul(EPOCH_LENGTH).div(YEAR_SECONDS);
    const principal = ethers.utils.parseEther("1000");
    const correctQuitFee = principal
      .mul(
        maintenanceFeePerEpoch.add(benchmarkProfit.mul(PROFIT_FEE).div(BASE))
      )
      .div(BASE);

    const quitFee = await accountingModule.calculateRageQuitFee(principal);
    expect(quitFee).to.be.equal(correctQuitFee);
  });

  it("should correctly change fees by executor and revert unauthorized access", async () => {
    const newImmediateFee = ethers.utils.parseEther("1");
    const newAnnualFee = ethers.utils.parseEther("2");
    await expect(
      accountingModule
        .connect(feeCollectorSigner)
        .setImmediateProfitFee(newImmediateFee)
    ).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(
      accountingModule
        .connect(feeCollectorSigner)
        .setAnnualMaintenanceFee(newAnnualFee)
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await sendArbitraryTx(
      gnosisSafe,
      accountingModule.address,
      accountingModule.interface.encodeFunctionData("setImmediateProfitFee", [
        newImmediateFee,
      ]),
      deployer
    );
    await sendArbitraryTx(
      gnosisSafe,
      accountingModule.address,
      accountingModule.interface.encodeFunctionData("setAnnualMaintenanceFee", [
        newAnnualFee,
      ]),
      deployer
    );

    const immediateFeeAfter = await accountingModule.getImmediateProfitFee();
    const annualFeeAfter = await accountingModule.getAnnualMaintenanceFee();

    expect(immediateFeeAfter).to.be.eq(newImmediateFee);
    expect(annualFeeAfter).to.be.eq(annualFeeAfter);
  });
});
