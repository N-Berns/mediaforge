import type { SpeedUnit } from "@mediaforge/shared-types";
import { createContext, useContext } from "react";

/** The saved speed unit. App loads it at start and updates it when Settings saves a new one. */
export const SpeedUnitContext = createContext<SpeedUnit>("bytes");

export const useSpeedUnit = (): SpeedUnit => useContext(SpeedUnitContext);
