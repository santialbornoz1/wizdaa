import { IsString, IsNumber, IsOptional, IsDateString, Min, IsIn } from 'class-validator';

export class CreateTimeOffRequestDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsNumber()
  @Min(1)
  daysRequested: number;

  @IsOptional()
  @IsIn(['VACATION', 'SICK', 'PERSONAL', 'OTHER'])
  type?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
