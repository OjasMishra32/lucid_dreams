using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace LucidDreams
{
    // A small JSON reader for the files JsonUtility can't map (nested number arrays in motion.json and skeleton.json).
    // Objects become Dictionary<string, object>, arrays List<object>, numbers double. Safe on worker threads.
    public static class MiniJson
    {
        public static object Parse(string json)
        {
            int i = 0;
            var value = Value(json, ref i);
            Skip(json, ref i);
            if (i != json.Length) throw new FormatException($"Unexpected '{json[i]}' at {i}");
            return value;
        }

        public static Dictionary<string, object> Obj(object o, string what) =>
            o as Dictionary<string, object> ?? throw new FormatException($"{what} must be an object");

        public static List<object> Arr(object o, string what) =>
            o as List<object> ?? throw new FormatException($"{what} must be an array");

        public static double Num(object o, string what) =>
            o is double d ? d : throw new FormatException($"{what} must be a number");

        // [x, y, z] (or any fixed length) as floats.
        public static float[] Floats(object o, int length, string what)
        {
            var a = Arr(o, what);
            if (a.Count != length) throw new FormatException($"{what} must have {length} numbers, has {a.Count}");
            var f = new float[length];
            for (int i = 0; i < length; i++) f[i] = (float)Num(a[i], what);
            return f;
        }

        static object Value(string s, ref int i)
        {
            Skip(s, ref i);
            if (i >= s.Length) throw new FormatException("Unexpected end of JSON");
            switch (s[i])
            {
                case '{':
                {
                    var o = new Dictionary<string, object>();
                    i++;
                    Skip(s, ref i);
                    if (s[i] == '}') { i++; return o; }
                    while (true)
                    {
                        Skip(s, ref i);
                        string key = Str(s, ref i);
                        Skip(s, ref i);
                        Expect(s, ref i, ':');
                        o[key] = Value(s, ref i);
                        Skip(s, ref i);
                        if (s[i] == ',') { i++; continue; }
                        Expect(s, ref i, '}');
                        return o;
                    }
                }
                case '[':
                {
                    var a = new List<object>();
                    i++;
                    Skip(s, ref i);
                    if (s[i] == ']') { i++; return a; }
                    while (true)
                    {
                        a.Add(Value(s, ref i));
                        Skip(s, ref i);
                        if (s[i] == ',') { i++; continue; }
                        Expect(s, ref i, ']');
                        return a;
                    }
                }
                case '"':
                    return Str(s, ref i);
                case 't':
                    Word(s, ref i, "true");
                    return true;
                case 'f':
                    Word(s, ref i, "false");
                    return false;
                case 'n':
                    Word(s, ref i, "null");
                    return null;
                default:
                {
                    int start = i;
                    while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
                    if (start == i) throw new FormatException($"Unexpected '{s[i]}' at {i}");
                    return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
                }
            }
        }

        static string Str(string s, ref int i)
        {
            Expect(s, ref i, '"');
            var sb = new StringBuilder();
            while (s[i] != '"')
            {
                char c = s[i++];
                if (c != '\\') { sb.Append(c); continue; }
                char e = s[i++];
                switch (e)
                {
                    case 'n': sb.Append('\n'); break;
                    case 't': sb.Append('\t'); break;
                    case 'r': sb.Append('\r'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u': sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; break;
                    default: sb.Append(e); break;
                }
            }
            i++;
            return sb.ToString();
        }

        static void Skip(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        static void Expect(string s, ref int i, char c)
        {
            if (i >= s.Length || s[i] != c) throw new FormatException($"Expected '{c}' at {i}");
            i++;
        }

        static void Word(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) throw new FormatException($"Expected {word} at {i}");
            i += word.Length;
        }
    }
}
