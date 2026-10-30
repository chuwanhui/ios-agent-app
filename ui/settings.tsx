import { CommonViewProps, EmptyView, HStack, Image, ShapeStyle, Spacer, Text, VStack } from "scripting"

export interface SettingsIconSpec {
  name: string
  color: ShapeStyle
}

export function SettingsIcon({ spec }: { spec: SettingsIconSpec }) {
  return (
    <Image
      systemName={spec.name}
      font="headline"
      foregroundStyle="white"
      frame={{ width: 34, height: 34 }}
      background={spec.color}
      clipShape={{ type: "rect", cornerRadius: 8 }}
    />
  )
}

export function SettingsNavRow({
  icon, title, detail, value, onOpen,
}: {
  icon: SettingsIconSpec
  title: string
  detail?: string
  value?: string
  onOpen: () => void
}) {
  return (
    <HStack
      spacing={12}
      padding={{ vertical: 3 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      contentShape="rect"
      onTapGesture={onOpen}
    >
      <SettingsIcon spec={icon} />
      <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text>{title}</Text>
        {detail ? (
          <Text font="footnote" foregroundStyle="secondaryLabel" lineLimit={2}>
            {detail}
          </Text>
        ) : <EmptyView />}
      </VStack>
      <Spacer />
      {value ? (
        <Text font="footnote" foregroundStyle="secondaryLabel" lineLimit={1}>
          {value}
        </Text>
      ) : <EmptyView />}
      <Image systemName="chevron.right" font="footnote" foregroundStyle="tertiaryLabel" />
    </HStack>
  )
}

export function SettingsListRow({
  icon, title, detail, status, statusColor = "secondaryLabel", onOpen, trailingSwipeActions,
}: {
  icon?: SettingsIconSpec
  title: string
  detail?: string
  status?: string
  statusColor?: ShapeStyle
  onOpen: () => void
  trailingSwipeActions?: CommonViewProps["trailingSwipeActions"]
}) {
  return (
    <HStack
      spacing={12}
      padding={{ vertical: 3 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      contentShape="rect"
      onTapGesture={onOpen}
      trailingSwipeActions={trailingSwipeActions}
    >
      {icon ? <SettingsIcon spec={icon} /> : <EmptyView />}
      <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <HStack spacing={6}>
          <Text foregroundStyle="label">{title}</Text>
          {status ? (
            <Text font="caption2" fontWeight="semibold" foregroundStyle={statusColor}>
              {status}
            </Text>
          ) : <EmptyView />}
        </HStack>
        {detail ? (
          <Text font="footnote" foregroundStyle="secondaryLabel" lineLimit={2}>
            {detail}
          </Text>
        ) : <EmptyView />}
      </VStack>
      <Image systemName="chevron.right" font="footnote" foregroundStyle="tertiaryLabel" />
    </HStack>
  )
}

export function SettingsSummaryRow({
  icon, title, value,
}: {
  icon?: SettingsIconSpec
  title: string
  value: string
}) {
  return (
    <HStack spacing={12} padding={{ vertical: 3 }} frame={{ maxWidth: "infinity" }}>
      {icon ? <SettingsIcon spec={icon} /> : <EmptyView />}
      <Text>{title}</Text>
      <Spacer />
      <Text font="footnote" foregroundStyle="secondaryLabel" lineLimit={1}>
        {value}
      </Text>
    </HStack>
  )
}

export function SettingsEmptyRow({
  icon = "tray", title, detail,
}: {
  icon?: string
  title: string
  detail?: string
}) {
  return (
    <VStack spacing={6} padding={{ vertical: 16 }} frame={{ maxWidth: "infinity" }}>
      <Image systemName={icon} font="title2" foregroundStyle="tertiaryLabel" />
      <Text fontWeight="semibold" foregroundStyle="secondaryLabel">
        {title}
      </Text>
      {detail ? (
        <Text font="footnote" foregroundStyle="tertiaryLabel" multilineTextAlignment="center">
          {detail}
        </Text>
      ) : <EmptyView />}
    </VStack>
  )
}
