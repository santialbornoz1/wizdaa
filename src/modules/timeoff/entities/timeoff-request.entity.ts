import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RequestStatus } from '../../../common/enums';

@Entity('timeoff_requests')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  @Column()
  startDate: string;

  @Column()
  endDate: string;

  @Column({ type: 'real' })
  daysRequested: number;

  @Column({ default: 'VACATION' })
  type: string;

  @Column({
    type: 'text',
    default: RequestStatus.PENDING_SYNC,
  })
  status: RequestStatus;

  @Column({ nullable: true })
  hcmTransactionId: string;

  @Column({ nullable: true })
  rejectionReason: string;

  @Column({ nullable: true, unique: true })
  idempotencyKey: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
