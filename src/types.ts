import { z } from 'zod';

// Dynamic component schema - accepts any component name with string or string array values
export const ComponentSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string())])
);

// Docker Compose configuration schemas
export const DockerServiceSchema = z.object({
  image: z.string().optional(),
  build: z
    .union([
      z.string(),
      z.object({
        context: z.string(),
        dockerfile: z.string().optional(),
        args: z.record(z.string()).optional(),
      }),
    ])
    .optional(),
  environment: z.array(z.string()).optional(),
  env_file: z.array(z.string()).optional(),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  platform: z.string().optional(),
  deploy: z
    .object({
      resources: z
        .object({
          reservations: z
            .object({
              devices: z
                .array(
                  z.object({
                    driver: z.string(),
                    capabilities: z.array(z.string()),
                  })
                )
                .optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
  profiles: z.array(z.string()).optional(),
  condition: z.string().optional(),
});

export const DockerComposeSchema = z.object({
  services: z.record(DockerServiceSchema),
  networks: z.record(z.any()).optional(),
  volumes: z.record(z.any()).optional(),
  profiles: z.array(z.string()).optional(),
});

export const ProfileSchema = z.object({
  name: z.string(),
  description: z.string(),
  extends: z.string().optional(),
  components: ComponentSchema,
  docker: DockerComposeSchema.optional(),
});

export type Components = z.infer<typeof ComponentSchema>;
export type ComponentValue = string | string[];
export type DockerServiceConfig = z.infer<typeof DockerServiceSchema>;
export type DockerComposeConfig = z.infer<typeof DockerComposeSchema>;
export type Profile = z.infer<typeof ProfileSchema>;

export interface EnvironmentConfig {
  [section: string]: {
    [key: string]: string;
  };
}

export interface BuildResult {
  success: boolean;
  envPath: string;
  profile?: Profile;
  errors?: string[];
  warnings?: string[];
}
