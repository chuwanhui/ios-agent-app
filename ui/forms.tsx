import { HStack, Text } from "scripting"

/**
 * 表单里「左侧固定宽度标签 + 右侧输入控件」的一行。
 * 设置页 / 模型页 / 工具页共用，所以放在 ui 层，别从某个业务页里 import。
 */
export function FieldRow(props: { label: string; children: any }) {
  return (
    <HStack spacing={8}>
      <Text frame={{ width: 84, alignment: "leading" }} foregroundStyle="secondaryLabel">
        {props.label}
      </Text>
      {props.children}
    </HStack>
  )
}
