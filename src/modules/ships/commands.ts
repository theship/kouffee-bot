import * as R from 'ramda';
import Eris from 'eris';
import mysql from 'mysql';
import numeral from 'numeral';
import dayjs, { Dayjs } from 'dayjs';
import { Option } from 'funfix-core';

import { dbNow, getConn, commit } from 'src/dbUtil';
import { CONF } from 'src/conf';
import { cmd } from 'src';
import {
  getUserFleetState,
  getUserProductionAndBalancesState,
  queueProductionJob,
  getInventoryForPlayer,
  getActiveRaid,
  RaidDurationTier,
  insertRaid,
} from './db';
import {
  Fleet,
  computeLiveFleet,
  queueFleetProduction,
  AllBuildableShipTypes,
  BuildableShip,
} from './fleet';
import {
  computeLiveUserProductionAndBalances,
  Balances,
  Production,
  ProductionJob,
  buildDefaultProduction,
} from './economy';
import { ProductionIncomeGetters } from './economy/curves/production';
import { setReminder, NotificationType } from './scheduler';
import { ProductionUpgradeCostGetters } from './economy/curves/productionUpgrades';
import { formatInventory, getRaidTimeDurString } from './formatters';
import { getAvailableRaidLocations, RaidLocation } from './raids';

const fmtCount = (count: number): string =>
  numeral(count).format(count > 10000 ? '1,000.0a' : '1,000');

const formatFleet = (fleet: Fleet): string => `
\`\`\`
${CONF.ships.ship_names['ship1']}: ${fmtCount(fleet.ship1)}
${CONF.ships.ship_names['ship2']}: ${fmtCount(fleet.ship2)}
${CONF.ships.ship_names['ship3']}: ${fmtCount(fleet.ship3)}
${CONF.ships.ship_names['ship4']}: ${fmtCount(fleet.ship4)}

${CONF.ships.ship_names['shipSpecial1']}: ${fmtCount(fleet.shipSpecial1)}
\`\`\`
`;

const formatBalances = (balances: Balances): string => `
\`\`\`
${CONF.ships.resource_names['tier1']}: ${fmtCount(balances.tier1)}
${CONF.ships.resource_names['tier2']}: ${fmtCount(balances.tier2)}
${CONF.ships.resource_names['tier3']}: ${fmtCount(balances.tier3)}

${CONF.ships.resource_names['special1']}: ${fmtCount(balances.special1)}
\`\`\`
`;

const formatProductionJob = (job: ProductionJob, curTier: number, now: Dayjs): string =>
  `\nUpgrade ${CONF.ships.resource_names[job.productionType]} Mine level ${curTier} -> ${curTier +
    1}; Completes ${now.to(job.endTime)}`;

const formatProductionUpgrades = (
  liveProduction: Production,
  now: Date,
  productionJobs: ProductionJob[]
): string | null => {
  const nowDayjs = dayjs(now);
  const nowTime = now.getTime();

  const applicableProductionJobs = productionJobs.filter(job => job.endTime.getTime() > nowTime);
  const [runningJob, ...pendingJobs] = applicableProductionJobs;
  if (R.isNil(runningJob)) {
    return null;
  }

  let msg = `

Running production job:${formatProductionJob(
    runningJob,
    liveProduction[runningJob.productionType],
    nowDayjs
  )}`;

  if (R.isEmpty(pendingJobs)) {
    return msg;
  }

  msg += '\n\nPending production jobs:';
  return pendingJobs.reduce(
    ({ production, msg }, job) => {
      return {
        msg: msg + formatProductionJob(job, production[job.productionType], nowDayjs),
        production: { ...production, [job.productionType]: production[job.productionType] + 1 },
      };
    },
    {
      production: {
        ...liveProduction,
        [runningJob.productionType]: liveProduction[runningJob.productionType] + 1,
      },
      msg,
    }
  ).msg;
};

const formatProduction = (
  production: Production,
  now: Date,
  productionJobsEndingAfterCheckpointTime: ProductionJob[]
): string => `
\`\`\`
${CONF.ships.resource_names['tier1']} Mine: Level ${fmtCount(production.tier1)} (${numeral(
  ProductionIncomeGetters.tier1(production.tier1, 1000)
).format('1,000.0')}/sec)
${CONF.ships.resource_names['tier2']} Mine: Level ${fmtCount(production.tier2)} (${numeral(
  ProductionIncomeGetters.tier2(production.tier2, 1000)
).format('1,000.0')}/sec)
${CONF.ships.resource_names['tier3']} Mine: Level ${fmtCount(production.tier3)} (${numeral(
  ProductionIncomeGetters.tier3(production.tier3, 1000)
).format('1,000.0')}/sec)${formatProductionUpgrades(
  production,
  now,
  productionJobsEndingAfterCheckpointTime
) || ''}
\`\`\`
`;

interface CommandHandlerArgs {
  client: Eris.Client;
  pool: mysql.Pool;
  msg: Eris.Message;
  userId: string;
  args: string[];
}

const printCurFleet = async ({ pool, userId }: CommandHandlerArgs) => {
  const conn = await getConn(pool);
  try {
    const {
      fleet,
      fleetJobsEndingAfterCheckpointTime: fleetJobsEndingAfterLastCommit,
    } = await getUserFleetState(conn, userId);
    const liveFleet = computeLiveFleet(await dbNow(conn), fleet, fleetJobsEndingAfterLastCommit);
    return formatFleet(liveFleet);
  } catch (err) {
    throw err;
  } finally {
    conn.release();
  }
};

const printCurBalances = async ({ pool, userId }: CommandHandlerArgs): Promise<string> => {
  const [conn1, conn2] = await Promise.all([getConn(pool), getConn(pool)] as const);

  try {
    const [
      now,
      { checkpointTime, balances, production, productionJobsEndingAfterCheckpointTime },
    ] = await Promise.all([
      dbNow(conn1),
      getUserProductionAndBalancesState(conn2, userId),
    ] as const);
    const { balances: liveBalances } = computeLiveUserProductionAndBalances(
      now,
      checkpointTime,
      balances,
      production,
      productionJobsEndingAfterCheckpointTime
    );

    return formatBalances(liveBalances);
  } finally {
    conn1.release();
    conn2.release();
  }
};

const printCurProduction = async ({ pool, userId }: CommandHandlerArgs): Promise<string> => {
  const [conn1, conn2] = await Promise.all([getConn(pool), getConn(pool)] as const);

  try {
    const [
      now,
      { checkpointTime, balances, production, productionJobsEndingAfterCheckpointTime },
    ] = await Promise.all([
      dbNow(conn1),
      getUserProductionAndBalancesState(conn2, userId),
    ] as const);
    const { production: liveProduction } = computeLiveUserProductionAndBalances(
      now,
      checkpointTime,
      balances,
      production,
      productionJobsEndingAfterCheckpointTime
    );

    return formatProduction(liveProduction, now, productionJobsEndingAfterCheckpointTime);
  } finally {
    conn1.release();
    conn2.release();
  }
};

const mkNameToKey = <T extends { [key: string]: string }>(map: T, isNumericKey = false) => (
  name: string | null | undefined
): keyof T | null => {
  if (R.isNil(name)) {
    return null;
  }

  const processedName = name.trim().toLowerCase();
  return Option.of(
    Object.entries(map).find(([, name]) => name.toLowerCase().startsWith(processedName))
  )
    .map(R.head)
    .map(k => (isNumericKey ? +k : k))
    .orNull();
};

type ArgsOf<T> = T extends (...args: infer A) => any ? A : never;

const lazyHOF = <F extends (...args: any) => any, T extends (...args: any) => F>(
  hof: T,
  getHOFArgs: () => ArgsOf<T>
): F => {
  let fn: F | null = null;

  return (((...args: ArgsOf<F>) => {
    if (!fn) {
      fn = hof(...(getHOFArgs() as any));
    }

    return fn(...(args as any));
  }) as any) as ReturnType<T>;
};

const productionKeys = Object.keys(buildDefaultProduction());
const productionNameToKey = lazyHOF<(k: string) => keyof Production | null, any>(
  mkNameToKey,
  () => [
    Object.fromEntries(
      Object.entries(CONF.ships.resource_names).filter(([key]: [keyof Production, string]) =>
        productionKeys.includes(key)
      )
    ) as { [K in keyof Production]: string },
  ]
);
const buildableShipNameToKey = lazyHOF<(k: string) => BuildableShip | null, any>(
  mkNameToKey,
  () => [
    Object.fromEntries(
      Object.entries(CONF.ships.ship_names).filter(([key]: [BuildableShip, string]) =>
        AllBuildableShipTypes.includes(key)
      )
    ) as { [K in BuildableShip]: string },
  ]
);
const raidLocationToKey = lazyHOF<(k: string) => RaidLocation | null, any>(mkNameToKey, () => [
  Object.fromEntries(
    Object.entries(CONF.ships.raid_location_names).map(([key, val]) => [key, val.name])
  ),
  true,
]);
const raidDurationToKey = lazyHOF<(k: string) => RaidDurationTier | null, any>(mkNameToKey, () => [
  {
    [RaidDurationTier.Short]: 'short',
    [RaidDurationTier.Medium]: 'medium',
    [RaidDurationTier.Long]: 'long',
  },
]);

const formatCost = (cost: Balances): string => {
  const sortedKeys: (keyof Balances)[] = [
    'tier1' as const,
    'tier2' as const,
    'tier3' as const,
    'special1' as const,
  ];
  if (sortedKeys.length !== Object.keys(cost).length) {
    throw new Error('Wrong key count in `formatCost`');
  }

  return sortedKeys
    .map(key => ({ key, val: cost[key] }))
    .filter(({ val }) => val > 0)
    .map(({ key, val }) => `${fmtCount(val)} ${CONF.ships.resource_names[key]}`)
    .join(', ');
};

const formatCurUpgradeCosts = (liveProduction: Production): string => `
\`\`\`
${CONF.ships.resource_names['tier1']} Level ${liveProduction.tier1} -> ${liveProduction.tier1 +
  1}: ${formatCost(ProductionUpgradeCostGetters.tier1(liveProduction.tier1).cost)}
${CONF.ships.resource_names['tier2']} Level ${liveProduction.tier2} -> ${liveProduction.tier2 +
  1}: ${formatCost(ProductionUpgradeCostGetters.tier2(liveProduction.tier2).cost)}
${CONF.ships.resource_names['tier3']} Level ${liveProduction.tier3} -> ${liveProduction.tier3 +
  1}: ${formatCost(ProductionUpgradeCostGetters.tier3(liveProduction.tier3).cost)}
\`\`\`
`;

const addByKey = <T>(a: T, b: T): T =>
  Object.fromEntries(
    Object.entries(a).map(([key, val]) => [key, val + Option.of(b[key as keyof T]).getOrElse(0)])
  );

const printCurUpgradeCosts = async (pool: mysql.Pool, userId: string): Promise<string> => {
  const conn = await getConn(pool);

  try {
    const {
      checkpointTime,
      balances: snapshottedBalances,
      production: snapshottedProduction,
      productionJobsEndingAfterCheckpointTime,
    } = await getUserProductionAndBalancesState(conn, userId);

    const now = await dbNow(pool);
    const nowTime = now.getTime();

    const { production: liveProduction } = computeLiveUserProductionAndBalances(
      now,
      checkpointTime,
      snapshottedBalances,
      snapshottedProduction,
      productionJobsEndingAfterCheckpointTime
    );

    const queuedUpgradeCountByTier = productionJobsEndingAfterCheckpointTime
      // Only care about jobs that haven't been accounted for when computing live production and balances
      .filter(job => job.endTime.getTime() > nowTime)
      .reduce<Production>(
        (acc, job) => ({ ...acc, [job.productionType]: acc[job.productionType] + 1 }),
        { tier1: 0, tier2: 0, tier3: 0 }
      );

    return formatCurUpgradeCosts(addByKey(liveProduction, queuedUpgradeCountByTier));
  } finally {
    conn.release();
  }
};

const upgradeProduction = async ({
  client,
  pool,
  msg,
  userId,
  args: [productionType],
}: CommandHandlerArgs): Promise<string> => {
  if (R.isNil(productionType)) {
    return printCurUpgradeCosts(pool, userId);
  }

  const productionKey = productionNameToKey(productionType);
  if (R.isNil(productionKey)) {
    return `Usage: \`${cmd('ships')} upgrade <mine type>\``;
  }

  const res = await queueProductionJob(pool, userId, productionKey);
  return res.fold<string | Promise<string>>(async ({ completionTime, upgradingToTier }) => {
    const channel = msg.channel;
    if (channel.type === 0) {
      await setReminder(
        client,
        pool,
        {
          userId,
          notificationType: NotificationType.ProductionUpgrade,
          notificationPayload: `${productionKey}-${upgradingToTier}`,
          guildId: channel.guild.id,
          channelId: msg.channel.id,
          reminderTime: completionTime,
        },
        await dbNow(pool)
      );
    } else {
      console.warn(`Unable to send notifications in channel type \`${channel.type}\``);
    }

    return `Upgrade queued!  Will complete ${dayjs(await dbNow(pool)).to(dayjs(completionTime))}`;
  }, R.prop('errorReason'));
};

const buildFleet = async ({
  client,
  msg,
  args,
  userId,
  pool,
}: CommandHandlerArgs): Promise<string> => {
  const [rawShipType, rawCount] = args;
  const shipType = Option.of(rawShipType)
    .map(buildableShipNameToKey)
    .orNull();
  const count = +rawCount;

  if (R.isNil(shipType) || R.isNil(rawCount) || Number.isNaN(count)) {
    return 'Usage: \`-s build <ship type> <count>\`';
  }

  const conn = await getConn(pool);
  try {
    return queueFleetProduction(client, msg, conn, userId, shipType, count);
  } catch (err) {
    console.error('Error while building fleet: ', err);
    return 'Error while queueing fleet for production';
  } finally {
    conn.release();
  }
};

const printInventory = async ({ pool, userId }: CommandHandlerArgs): Promise<string | string[]> => {
  const inventoryForPlayer = await getInventoryForPlayer(pool, userId);
  return formatInventory(inventoryForPlayer);
};

const formatRaidLocations = (names: RaidLocation[]): string =>
  names
    .map(loc => CONF.ships.raid_location_names[loc])
    .map(R.prop('name'))
    .join(', ');

const getRaidDurationMs = (durationTier: RaidDurationTier): number =>
  ({
    // [RaidDurationTier.Short]: 45 * 60 * 1000,
    // [RaidDurationTier.Medium]: 2 * 60 * 60 * 1000,
    // [RaidDurationTier.Long]: 8 * 60 * 60 * 1000,
    [RaidDurationTier.Short]: 2 * 1000,
    [RaidDurationTier.Medium]: 5 * 1000,
    [RaidDurationTier.Long]: 10 * 1000,
  }[durationTier]);

const raid = async ({
  userId,
  pool,
  args,
  client,
  msg,
}: CommandHandlerArgs): Promise<string | string[]> => {
  const [rawLocation, rawDuration] = args;

  if (R.isNil(rawLocation) || R.isNil(rawDuration)) {
    const activeRaid = await getActiveRaid(pool, userId);

    if (activeRaid.isEmpty()) {
      const inventory = await getInventoryForPlayer(pool, userId);
      const availableRaidLocations = await getAvailableRaidLocations(userId, inventory);

      return [
        `You have no active raid.  You have access to the following raid locations: ${formatRaidLocations(
          availableRaidLocations
        )}`,
        `You can start a raid with \`${cmd('raid')} <location> <short|med|long>\``,
      ];
    } else {
      const raid = activeRaid.get();
      const now = await dbNow(pool);
      const remainingTimeString = dayjs(now).to(dayjs(raid.returnTime));

      return `You have an active ${getRaidTimeDurString(raid.durationTier)} raid to ${
        CONF.ships.raid_location_names[raid.location].name
      }.  It will return ${remainingTimeString}`;
    }
  }

  const inventory = await getInventoryForPlayer(pool, userId);
  const availableRaidLocations = await getAvailableRaidLocations(userId, inventory);
  const location = raidLocationToKey(rawLocation);
  if (location === null) {
    return `Unknown raid location.  Available raid locations: ${formatRaidLocations(
      availableRaidLocations
    )}`;
  } else if (!availableRaidLocations.includes(location)) {
    return `Location unavailable.  Available raid locations: ${formatRaidLocations(
      availableRaidLocations
    )}`;
  }

  const durationTier = raidDurationToKey(rawDuration);
  if (durationTier === null) {
    return 'Invalid raid duration; must be one of short, medium, long';
  }

  const conn = await getConn(pool);
  try {
    return await new Promise<string>((resolve, reject) => {
      conn.beginTransaction(async err => {
        if (err) {
          reject(err);
          return;
        }

        try {
          // Figure out what the current fleet looks like which will be sent on this raid
          const [
            now,
            { fleet: checkpointFleet, fleetJobsEndingAfterCheckpointTime },
          ] = await Promise.all([dbNow(pool), getUserFleetState(conn, userId)] as const);
          const liveFleet = computeLiveFleet(
            now,
            checkpointFleet,
            fleetJobsEndingAfterCheckpointTime
          );

          // Compute departure + return time and send off the fleet
          const departureTime = now;
          const returnTime = dayjs(departureTime)
            .add(getRaidDurationMs(durationTier), 'ms')
            .toDate();

          await insertRaid(conn, {
            userId,
            durationTier,
            location,
            departureTime,
            returnTime,
            ...liveFleet,
          });

          // Register a reminder for when the fleet returns
          if (msg.channel.type === 0) {
            setReminder(
              client,
              conn,
              {
                userId,
                notificationType: NotificationType.RaidReturn,
                guildId: msg.channel.guild.id,
                channelId: msg.channel.id,
                notificationPayload: '',
                reminderTime: returnTime,
              },
              now
            );
          } else {
            console.warn(
              'Raid dispatch message received on non-text channel or something; not setting notification.'
            );
          }

          await commit(conn);
          resolve(`Raid has been dispatched!  It will return ${dayjs(now).to(returnTime)}`);
        } catch (err) {
          console.error(err);
          conn.rollback();
          reject(err);
        }
      });
    });
  } catch (err) {
    throw err;
  } finally {
    conn.release();
  }
};

const CommandHandlers: {
  [command: string]: (args: CommandHandlerArgs) => Promise<string | string[]>;
} = {
  f: printCurFleet,
  fleet: printCurFleet,
  build: buildFleet,
  bal: printCurBalances,
  balance: printCurBalances,
  balances: printCurBalances,
  prod: printCurProduction,
  production: printCurProduction,
  up: upgradeProduction,
  upgrade: upgradeProduction,
  inv: printInventory,
  inventory: printInventory,
  raid,
};

export const maybeHandleCommand = ({
  splitContent,
  ...params
}: {
  client: Eris.Client;
  pool: mysql.Pool;
  msg: Eris.Message;
  userId: string;
  splitContent: string[];
}): undefined | Promise<string | string[]> => {
  const [command, ...args] = splitContent;
  const handler = CommandHandlers[command];
  if (!handler) {
    return;
  }

  return handler({ ...params, args });
};
