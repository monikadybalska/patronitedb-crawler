import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller('authors')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  writeToInfluxDB() {
    return this.appService.writeToInfluxDB();
  }
}
