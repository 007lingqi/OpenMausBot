import { z } from "zod";

const fixedImage = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const rolesSchema = z.strictObject({ serviceImage: fixedImage, coordinatorImage: fixedImage, providerImage: fixedImage });
const serviceSchema = z.object({ image: z.string(), environment: z.record(z.string(), z.json()) }).catchall(z.json());
export type ReleaseServiceConfig = z.infer<typeof serviceSchema>;

export interface ReleaseImageRoles {
  serviceImage: string;
  coordinatorImage: string;
  providerImage: string;
}

function expectedRoles(expected: ReleaseImageRoles): ReleaseImageRoles {
  const parsed = rolesSchema.safeParse(expected);
  if (!parsed.success) throw new Error("release_image_expected_invalid");
  if (parsed.data.coordinatorImage !== parsed.data.serviceImage) throw new Error("release_image_coordinator_mismatch");
  return parsed.data;
}

function readService(service: Parameters<typeof serviceSchema.safeParse>[0]) {
  const parsed = serviceSchema.safeParse(service);
  if (!parsed.success) throw new Error("release_image_service_invalid");
  const roles = rolesSchema.safeParse({ serviceImage: parsed.data.image,
    coordinatorImage: parsed.data.environment.OMB_DOCKER_COORDINATOR_IMAGE,
    providerImage: parsed.data.environment.OMB_DOCKER_PROVIDER_IMAGE });
  if (!roles.success) throw new Error("release_image_roles_invalid");
  if (roles.data.coordinatorImage !== roles.data.serviceImage) throw new Error("release_image_coordinator_mismatch");
  return { service: parsed.data, roles: roles.data };
}

/** Checks a resolved release candidate, not templates or a global image-equality policy. */
export function assertReleaseImageContract(service: Parameters<typeof serviceSchema.safeParse>[0], expected: ReleaseImageRoles): void {
  const wanted = expectedRoles(expected), actual = readService(service).roles;
  if (actual.serviceImage !== wanted.serviceImage) throw new Error("release_image_service_mismatch");
  if (actual.coordinatorImage !== wanted.coordinatorImage) throw new Error("release_image_coordinator_mismatch");
  if (actual.providerImage !== wanted.providerImage) throw new Error("release_image_provider_mismatch");
}

/** Pins only the explicitly supplied roles; command/test images remain independent. */
export function pinReleaseImageContract(service: Parameters<typeof serviceSchema.safeParse>[0], expected: ReleaseImageRoles): ReleaseServiceConfig {
  const wanted = expectedRoles(expected), cloned = structuredClone(readService(service).service);
  cloned.image = wanted.serviceImage;
  cloned.environment.OMB_DOCKER_COORDINATOR_IMAGE = wanted.coordinatorImage;
  cloned.environment.OMB_DOCKER_PROVIDER_IMAGE = wanted.providerImage;
  assertReleaseImageContract(cloned, wanted);
  return cloned;
}
