import React from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.jsx'
import { cn } from './lib/utils.js'
import { clock, duration, group, isPeak, money, scale } from './format.js'

const COLUMNS = [
  { key: 'time', label: '时间', width: 'w-[84px]', help: '结算时间；悬停可看到本次请求的开始时间' },
  { key: 'state', label: '状态', width: 'w-[62px]', help: '只有失败才标出来：成功＝产出了消息，失败＝本次尝试没有产出消息' },
  { key: 'model', label: '模型', width: '', help: '这次请求实际使用的 provider / model' },
  { key: 'input', label: '未缓存输入', width: 'w-[98px]', numeric: true, help: '未命中缓存的输入 token；有缓存写入时以 +N 标出' },
  { key: 'cache', label: '缓存读取', width: 'w-[92px]', numeric: true, help: '命中缓存、按缓存价计费的输入 token' },
  { key: 'output', label: '输出', width: 'w-[78px]', numeric: true, help: '模型输出的 token' },
  { key: 'cost', label: '费用', width: 'w-[82px]', numeric: true, help: '按官网单价与峰谷时段估算，非账单；悬停可看本次按高峰还是空闲计' },
  { key: 'firstToken', label: '首字', width: 'w-[64px]', numeric: true, help: '请求开始到第一个流式片段的时间；未流式返回时为 —' },
  { key: 'duration', label: '耗时', width: 'w-[64px]', numeric: true, help: '本次请求从开始到结算的时间' },
]

/** One row per settlement, newest first; the provider only repeats when it changes. */
export function RequestsTable({ rows, currency = '¥', today }) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-[11px] text-subtle-foreground">
        还没有请求记录：一次模型调用结算后就会出现在这里。
      </div>
    )
  }

  return (
    <Table className="table-fixed">
      <colgroup>
        {COLUMNS.map(column => (
          <col key={column.key} className={column.width} />
        ))}
      </colgroup>
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow className="hover:bg-transparent">
          {COLUMNS.map((column, index) => (
            <TableHead
              key={column.key}
              title={column.help}
              className={cn(
                column.numeric ? 'text-right' : 'text-left',
                index === 0 && 'pl-4',
                index === COLUMNS.length - 1 && 'pr-4',
              )}
            >
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => {
          const previous = rows[index - 1]
          const showProvider = previous === undefined || previous.provider !== row.provider
          return (
            <TableRow key={`${row.time}-${row.model}-${row.output}`} className={row.failed ? 'bg-danger/5' : undefined}>
              <TableCell
                className="pl-4 text-[11px] text-subtle-foreground"
                title={
                  row.start === null || row.start === undefined
                    ? undefined
                    : `开始 ${clock(row.start, today)} · 结束 ${clock(row.time, today)}`
                }
              >
                {clock(row.time, today)}
              </TableCell>
              <TableCell>
                {/* Only a failure earns a mark: a column of identical green
                    dots spends width and says nothing. */}
                {row.failed ? (
                  <span
                    className="inline-flex items-center gap-1.5 text-[11px] text-danger"
                    title="本次尝试没有产出消息，用量为最后一次上报的样本"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                    失败
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="truncate" title={`${row.provider}/${row.model}`}>
                <span className="text-foreground">{row.model}</span>
                {showProvider && row.provider ? (
                  <span className="ml-1.5 text-[10px] text-subtle-foreground">{row.provider}</span>
                ) : null}
              </TableCell>
              <TableCell
                className="text-right"
                title={`${group(row.input)} tok 未缓存 · ${group(row.cacheWrite)} tok 写入`}
              >
                {scale(row.input)}
                {row.cacheWrite > 0 ? (
                  <span className="ml-0.5 text-[10px] text-subtle-foreground">+{scale(row.cacheWrite)}</span>
                ) : null}
              </TableCell>
              <TableCell className="text-right" title={`${group(row.cacheRead)} tok`}>
                {scale(row.cacheRead)}
              </TableCell>
              <TableCell className="text-right">{scale(row.output)}</TableCell>
              <TableCell
                className="pr-0 text-right font-medium"
                title={row.cost === null || row.cost === undefined ? undefined : `${isPeak(row.time) ? '高峰 ×1' : '空闲 ×0.5'} · 官网价估算，非账单`}
              >
                {row.cost === null || row.cost === undefined ? (
                  <span className="font-normal text-subtle-foreground">—</span>
                ) : (
                  money(row.cost, currency)
                )}
              </TableCell>
              <TableCell className="text-right text-[11px] text-subtle-foreground">
                {duration(row.firstToken)}
              </TableCell>
              <TableCell className="pr-4 text-right text-[11px] text-subtle-foreground">
                {duration(row.duration)}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
