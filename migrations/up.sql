CREATE TABLE `economy_balances` (
  `user_id` BIGINT NOT NULL,
  `balance` BIGINT NOT NULL
) ENGINE = InnoDB;
ALTER TABLE `economy_balances` ADD UNIQUE(`user_id`);
ALTER TABLE `economy_balances` ADD PRIMARY KEY(`user_id`);

CREATE TABLE `economy_dailies` (
  `user_id` BIGINT NOT NULL ,
  `last_claim_timestamp` TIMESTAMP NOT NULL
) ENGINE = InnoDB;
ALTER TABLE `economy_dailies` ADD UNIQUE(`user_id`);
ALTER TABLE `economy_dailies` ADD PRIMARY KEY(`user_id`);

CREATE TABLE `ships_fleets` (
  `userId` BIGINT NOT NULL,
  `checkpointTime` TIMESTAMP NOT NULL,
  `ship1` BIGINT NOT NULL,
  `ship2` BIGINT NOT NULL,
  `ship3` BIGINT NOT NULL,
  `ship4` BIGINT NOT NULL,
  `shipSpecial1` BIGINT NOT NULL
) ENGINE = InnoDB;
ALTER TABLE `ships_fleets` ADD UNIQUE(`userId`);

CREATE TABLE `ships_fleets-jobs` (
  `userId` BIGINT NOT NULL,
  `jobType` VARCHAR(191) NOT NULL,
  `startTime` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `endTime` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `shipType` VARCHAR(191) NOT NULL,
  `shipCount` BIGINT NOT NULL
) ENGINE = InnoDB;
ALTER TABLE `ships_fleets-jobs` ADD INDEX(`endTime` DESC);

CREATE TABLE `ships_production` (
  `userId` BIGINT NOT NULL,
  `checkpointTime` TIMESTAMP NOT NULL,
  `tier1Prod` BIGINT NOT NULL,
  `tier2Prod` BIGINT NOT NULL,
  `tier3Prod` BIGINT NOT NULL,
  `tier1Bal` BIGINT NOT NULL,
  `tier2Bal` BIGINT NOT NULL,
  `tier3Bal` BIGINT NOT NULL,
  `special1Bal` BIGINT NOT NULL
) ENGINE = InnoDB;
ALTER TABLE `ships_production` ADD UNIQUE(`userId`);

CREATE TABLE `ships_production-jobs` (
  `userId` BIGINT NOT NULL,
  `jobType` VARCHAR(191) NOT NULL,
  `startTime` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `endTime` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `productionType` VARCHAR(191) NOT NULL
) ENGINE = InnoDB;
ALTER TABLE `ships_production-jobs` ADD INDEX(`endTime` DESC);
