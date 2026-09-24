/**
 * BobAdapter — shape type for the IBM Bob Shell provider adapter.
 *
 * The driver model ({@link ../Drivers/BobDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module BobAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * BobAdapterShape — per-instance Bob adapter contract.
 */
export interface BobAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
