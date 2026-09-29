import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

// @Global: imported once in AppModule, DatabaseService is injectable everywhere.
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
