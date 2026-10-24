// A soft dark disc on the real floor under the person's feet. Colour stays black and alpha carries the darkness,
// so over passthrough it darkens the real floor instead of painting a grey patch.
Shader "LucidDreams/ContactShadow"
{
    Properties
    {
        _Opacity ("Opacity", Range(0, 1)) = 0.45
    }
    SubShader
    {
        Tags { "RenderType"="Transparent" "Queue"="Transparent-50" "RenderPipeline"="UniversalPipeline" }
        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            Blend SrcAlpha OneMinusSrcAlpha, One OneMinusSrcAlpha
            ZWrite Off
            ZTest LEqual
            Cull Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_instancing
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            CBUFFER_START(UnityPerMaterial)
            half _Opacity;
            CBUFFER_END

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv : TEXCOORD0;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            Varyings vert(Attributes input)
            {
                Varyings output;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);
                output.positionCS = TransformObjectToHClip(input.positionOS.xyz);
                output.uv = input.uv;
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                // Dark core under the feet that fades smoothly to nothing at the edge.
                float r = length(input.uv * 2.0 - 1.0);
                half a = _Opacity * saturate(1.0 - r) * saturate(1.0 - r) * (1.0 + 0.6 * saturate(1.0 - 2.5 * r));
                return half4(0, 0, 0, saturate(a));
            }
            ENDHLSL
        }
    }
}
