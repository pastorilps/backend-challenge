import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
  clientUrl:
    process.env.DATABASE_URL ||
    'postgresql://root:rootpassword@localhost:5432/my_database',

  entities: ['./dist/entities/**/*.js'],
  entitiesTs: ['./src/entities/**/*.ts'],

  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    glob: '!(*.d).{js,ts}',

    transactional: true,
    allOrNothing: true,
    disableForeignKeys: true,

    tableName: 'mikro_orm_migrations',
  },
});