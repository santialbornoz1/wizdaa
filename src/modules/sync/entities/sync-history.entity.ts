import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('sync_history')
export class SyncHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  type: string; // 'BATCH' | 'INDIVIDUAL' | 'ROLLBACK'

  @Column({ nullable: true })
  requestId: string;

  @Column({ nullable: true })
  employeeId: string;

  @Column({ nullable: true })
  locationId: string;

  @Column()
  status: string; // 'SUCCESS' | 'FAILED' | 'RETRYING'

  @Column({ nullable: true, type: 'text' })
  errorMessage: string;

  @Column({ default: 0 })
  attemptNumber: number;

  @CreateDateColumn()
  createdAt: Date;
}
