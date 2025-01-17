import { setupMUDV2Network } from "@latticexyz/std-client";
import { createFastTxExecutor, createFaucetService, normalizeEntityID } from "@latticexyz/network";
import { getNetworkConfig } from "./getNetworkConfig";
import { defineContractComponents } from "./contractComponents";
import { clientComponents } from "./clientComponents";
import { world } from "./world";
import {
  EntityID,
  EntityIndex,
  getComponentValue,
  Has,
  HasValue,
  overridableComponent,
  runQuery,
} from "@latticexyz/recs";
import { awaitStreamValue, uuid } from "@latticexyz/utils";
import { Contract, Signer, utils } from "ethers";
import { JsonRpcProvider } from "@ethersproject/providers";
import { IWorld__factory } from "../../../contracts/types/ethers-contracts/factories/IWorld__factory";
import { extractContractError } from "./extractContractError";

export type SetupResult = Awaited<ReturnType<typeof setup>>;

export async function setup() {
  const contractComponents = defineContractComponents(world);
  const networkConfig = await getNetworkConfig();
  const result = await setupMUDV2Network<typeof contractComponents>({
    networkConfig,
    world,
    contractComponents,
    syncThread: "main",
  });

  result.startSync();

  // Request drip from faucet
  const signer = result.network.signer.get();
  if (!networkConfig.devMode && networkConfig.faucetServiceUrl && signer) {
    const address = await signer.getAddress();
    console.info("[Dev Faucet]: Player address -> ", address);

    const faucet = createFaucetService(networkConfig.faucetServiceUrl);

    const requestDrip = async () => {
      const balance = await signer.getBalance();
      console.info(`[Dev Faucet]: Player balance -> ${balance}`);
      const lowBalance = balance?.lte(utils.parseEther("1"));
      if (lowBalance) {
        console.info("[Dev Faucet]: Balance is low, dripping funds to player");
        // Double drip
        await faucet.dripDev({ address });
        await faucet.dripDev({ address });
      }
    };

    requestDrip();
    // Request a drip every 20 seconds
    setInterval(requestDrip, 20000);
  }

  // Create a World contract instance
  const worldContract = IWorld__factory.connect(
    networkConfig.worldAddress,
    signer ?? result.network.providers.get().json
  );

  // Create a fast tx executor
  const fastTxExecutor =
    signer?.provider instanceof JsonRpcProvider
      ? await createFastTxExecutor(signer as Signer & { provider: JsonRpcProvider })
      : null;

  // TODO: infer this from fastTxExecute signature?
  type BoundFastTxExecuteFn<C extends Contract> = <F extends keyof C>(
    func: F,
    args: Parameters<C[F]>,
    options?: {
      retryCount?: number;
    }
  ) => Promise<ReturnType<C[F]>>;

  function bindFastTxExecute<C extends Contract>(contract: C): BoundFastTxExecuteFn<C> {
    return async function (...args) {
      if (!fastTxExecutor) {
        throw new Error("no signer");
      }
      try {
        const { tx } = await fastTxExecutor.fastTxExecute(contract, ...args);
        return await tx;
      } catch (error) {
        console.error(extractContractError(worldContract, error));
        throw error;
      }
    };
  }

  const worldSend = bindFastTxExecute(worldContract);

  const components = {
    ...result.components,
    Position: overridableComponent(result.components.Position),
    Player: overridableComponent(result.components.Player),
    Health: overridableComponent(result.components.Health),
    Strength: overridableComponent(result.components.Strength),
    ...clientComponents,
  };

  const wrapPosition = (x: number, y: number) => {
    const mapConfig = getComponentValue(components.MapConfig, result.singletonEntity);
    if (!mapConfig) {
      throw new Error("mapConfig no yet loaded or initialized");
    }
    return [(x + mapConfig.width) % mapConfig.width, (y + mapConfig.height) % mapConfig.height];
  };

  const isObstructed = (x: number, y: number) => {
    return runQuery([Has(components.Obstruction), HasValue(components.Position, { x, y })]).size > 0;
  };

  const moveTo = async (x: number, y: number) => {
    if (!result.playerEntity) {
      throw new Error("no player");
    }

    const [wrappedX, wrappedY] = wrapPosition(x, y);
    if (isObstructed(wrappedX, wrappedY)) {
      console.warn("cannot move to obstructed space");
      return;
    }

    const inEncounter = !!getComponentValue(components.Encounter, result.playerEntity);
    if (inEncounter) {
      console.warn("cannot move while in encounter");
      return;
    }

    const positionId = uuid();
    components.Position.addOverride(positionId, {
      entity: result.playerEntity,
      value: { x: wrappedX, y: wrappedY },
    });

    try {
      // Our system checks distance on the original/requested x,y and then wraps for us,
      // so we'll pass the original x,y here.
      // TODO: make the contract smarter about calculating wrapped distance
      const tx = await worldSend("move", [x, y]);
      await awaitStreamValue(result.txReduced$, (txHash) => txHash === tx.hash);
    } finally {
      components.Position.removeOverride(positionId);
    }
  };

  const moveBy = async (deltaX: number, deltaY: number) => {
    if (!result.playerEntity) {
      throw new Error("no player");
    }

    const playerPosition = getComponentValue(components.Position, result.playerEntity);
    if (!playerPosition) {
      console.warn("cannot moveBy without a player position, not yet spawned?");
      return;
    }

    await moveTo(playerPosition.x + deltaX, playerPosition.y + deltaY);
  };

  const spawn = async (x: number, y: number) => {
    if (!result.playerEntity) {
      throw new Error("no player");
    }

    const canSpawn = getComponentValue(components.Player, result.playerEntity)?.value !== true;
    if (!canSpawn) {
      throw new Error("already spawned");
    }

    const [wrappedX, wrappedY] = wrapPosition(x, y);
    if (isObstructed(wrappedX, wrappedY)) {
      console.warn("cannot spawn on obstructed space");
      return;
    }

    const positionId = uuid();
    components.Position.addOverride(positionId, {
      entity: result.playerEntity,
      value: { x: wrappedX, y: wrappedY },
    });
    const playerId = uuid();
    components.Player.addOverride(playerId, {
      entity: result.playerEntity,
      value: { value: true },
    });

    try {
      const tx = await worldSend("spawn", [wrappedX, wrappedY]);
      await awaitStreamValue(result.txReduced$, (txHash) => txHash === tx.hash);
    } finally {
      components.Position.removeOverride(positionId);
      components.Player.removeOverride(playerId);
    }
  };

  const throwBall = async () => {
    const player = result.playerEntity;
    if (!player) {
      throw new Error("no player");
    }

    const encounter = getComponentValue(components.Encounter, player);
    if (!encounter) {
      throw new Error("no encounter");
    }

    const tx = await worldSend("throwBall", []);
    await awaitStreamValue(result.txReduced$, (txHash) => txHash === tx.hash);

    const hasCaught = encounter.monsters.some((monsterId) => {
      const monster = world.entityToIndex.get(monsterId as EntityID);
      const owner = monster && getComponentValue(components.OwnedBy, monster)?.value;
      return monster && owner && normalizeEntityID(owner) === world.entities[player];
    });
    if (hasCaught) {
      return "caught";
    }

    if (!getComponentValue(components.Encounter, player)) {
      return "fled";
    }

    return "miss";
  };

  //Attack function
  const attack = async () => {
    const tx = await worldSend("attack", []);
    await awaitStreamValue(result.txReduced$, (txHash) => txHash === tx.hash)
  }

  const fleeEncounter = async () => {
    const tx = await worldSend("flee", []);
    await awaitStreamValue(result.txReduced$, (txHash) => txHash === tx.hash);
  };

  return {
    ...result,
    components,
    worldContract,
    worldSend,
    fastTxExecutor,
    api: {
      moveTo,
      moveBy,
      spawn,
      throwBall,
      fleeEncounter,
      attack
    },
  };
}
