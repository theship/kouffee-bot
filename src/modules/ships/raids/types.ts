import { Item } from '../inventory/item';
import { Fleet } from '../fleet';

export enum RaidDurationTier {
  Short,
  Medium,
  Long,
}

export enum RaidLocation {
  Location1,
  Location2,
  Location3,
}

export interface RaidResult {
  userId: string;
  completionTime: Date;
  rewardItems: Item[];
  fleet: Fleet;
  durationTier: RaidDurationTier;
  fleetDiff: Fleet | null;
  location: RaidLocation;
}
