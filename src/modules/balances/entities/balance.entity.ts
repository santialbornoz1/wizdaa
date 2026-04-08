import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

@Entity('balances')
@Unique(['employeeId', 'locationId'])
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  @Column({ type: 'real', default: 0 })
  totalDays: number;

  @Column({ type: 'real', default: 0 })
  usedDays: number;

  @Column({ type: 'real', default: 0 })
  availableDays: number;

  @Column({ nullable: true })
  lastSyncedAt: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
